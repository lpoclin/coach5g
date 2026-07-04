package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// ExecHandler serves GET /ws/exec/:namespace/:pod/:container -- an
// interactive shell into a running pod via the Kubernetes exec subresource.
//
// Unlike TerminalHandler (SSH), there is no login step: Kubernetes RBAC --
// specifically, whatever the dedicated exec-only ServiceAccount bound to cs
// is allowed to do (see helm/templates/rbac-exec.yaml) -- is the sole
// authorization boundary, per docs/RISK_ASSESSMENT_ADDITIONS.md Addition 4
// and docs/EXEC_IDENTITY_ASSESSMENT.md. This handler does not add a second,
// per-user identity check on top of that.
type ExecHandler struct {
	cs     *kubernetes.Clientset
	config *rest.Config
}

// NewExecHandler constructs an ExecHandler. cs/config must be built from the
// dedicated exec-only ServiceAccount's token (k8s.NewExecConfig), never the
// shared read-only ServiceAccount used everywhere else in this package.
func NewExecHandler(cs *kubernetes.Clientset, config *rest.Config) *ExecHandler {
	return &ExecHandler{cs: cs, config: config}
}

// ─── Shell fallback ───────────────────────────────────────────────────────────

var shellCandidates = []string{"/bin/bash", "/bin/sh"}

// isShellNotFoundErr reports whether err is the container runtime's specific
// "exec target binary does not exist" failure, as opposed to a permissions
// error (RBAC denial, no matching container) or a connectivity error
// (context cancelled, API server unreachable). Only the former should
// trigger the bash→sh fallback; the latter must be surfaced to the user
// as-is, not masked by a second, equally-doomed attempt.
func isShellNotFoundErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "executable file not found") ||
		(strings.Contains(msg, "no such file or directory") && strings.Contains(msg, "exec"))
}

// execAttempt opens one exec stream running shellPath as the sole command.
// It returns whatever error the Kubernetes API / container runtime reports;
// callers distinguish "shell not found" from everything else via
// isShellNotFoundErr.
func execAttempt(
	ctx context.Context,
	cs *kubernetes.Clientset,
	config *rest.Config,
	namespace, pod, container, shellPath string,
	stdin io.Reader,
	stdout io.Writer,
	sizeQueue remotecommand.TerminalSizeQueue,
) error {
	req := cs.CoreV1().RESTClient().Post().
		Resource("pods").
		Namespace(namespace).
		Name(pod).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   []string{shellPath},
			Stdin:     true,
			Stdout:    true,
			// TTY sessions multiplex stdout+stderr into one stream; the
			// Kubernetes exec API rejects a request that sets both TTY and
			// Stderr.
			Stderr: false,
			TTY:    true,
		}, scheme.ParameterCodec)

	exec, err := remotecommand.NewSPDYExecutor(config, "POST", req.URL())
	if err != nil {
		return err
	}
	return exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             stdin,
		Stdout:            stdout,
		Tty:               true,
		TerminalSizeQueue: sizeQueue,
	})
}

// ─── Terminal resize queue ────────────────────────────────────────────────────

// resizeQueue adapts WS "resize" messages to remotecommand.TerminalSizeQueue.
// Buffered at 1 and always overwritten with the latest size, since only the
// most recent terminal geometry matters.
type resizeQueue struct {
	ch chan remotecommand.TerminalSize
}

func newResizeQueue() *resizeQueue {
	return &resizeQueue{ch: make(chan remotecommand.TerminalSize, 1)}
}

func (q *resizeQueue) push(cols, rows uint16) {
	select {
	case <-q.ch:
	default:
	}
	select {
	case q.ch <- remotecommand.TerminalSize{Width: cols, Height: rows}:
	default:
	}
}

func (q *resizeQueue) Next() *remotecommand.TerminalSize {
	size, ok := <-q.ch
	if !ok {
		return nil
	}
	return &size
}

// ─── stdout → WebSocket ───────────────────────────────────────────────────────

// wsStdout wraps WS writes as {"type":"output"} frames, matching the same
// termMsg wire shape terminal.go's SSH sessions already use. mu is shared
// with the handler's own out-of-band messages (e.g. the "no shell found"
// notice) since gorilla/websocket connections aren't safe for concurrent
// writes from multiple goroutines.
type wsStdout struct {
	conn *websocket.Conn
	mu   *sync.Mutex
}

func (w *wsStdout) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := sendTermMsg(w.conn, termMsg{Type: "output", Data: string(p)}); err != nil {
		return 0, err
	}
	return len(p), nil
}

// ─── Handler ──────────────────────────────────────────────────────────────────

func (h *ExecHandler) HandleExec(c *gin.Context) {
	namespace := c.Param("namespace")
	pod := c.Param("pod")
	container := c.Param("container")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("ws upgrade exec")
		return
	}
	defer conn.Close()

	var writeMu sync.Mutex
	sendMsg := func(msg termMsg) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = sendTermMsg(conn, msg)
	}
	stdout := &wsStdout{conn: conn, mu: &writeMu}

	// One stdin pipe and resize queue shared across both shell attempts --
	// safe because a "shell not found" failure happens before the user can
	// have typed anything (see execAttempt/isShellNotFoundErr above).
	stdinReader, stdinWriter := io.Pipe()
	sizes := newResizeQueue()

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	go func() {
		defer stdinWriter.Close()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				cancel()
				return
			}
			var msg termMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "input":
				if _, err := stdinWriter.Write([]byte(msg.Data)); err != nil {
					return
				}
			case "resize":
				cols, rows := msg.Cols, msg.Rows
				if cols == 0 {
					cols = 80
				}
				if rows == 0 {
					rows = 24
				}
				sizes.push(uint16(cols), uint16(rows))
			}
		}
	}()

	log.Info().Str("namespace", namespace).Str("pod", pod).Str("container", container).Msg("exec session opened")

	var execErr error
	for i, shellPath := range shellCandidates {
		execErr = execAttempt(ctx, h.cs, h.config, namespace, pod, container, shellPath, stdinReader, stdout, sizes)
		if execErr == nil || !isShellNotFoundErr(execErr) || i == len(shellCandidates)-1 {
			break
		}
	}

	switch {
	case execErr == nil:
		sendMsg(termMsg{Type: "output", Data: "\r\n\x1b[2m[session closed]\x1b[0m\r\n"})
	case isShellNotFoundErr(execErr):
		sendMsg(termMsg{Type: "output", Data: "\r\n\x1b[31mNo shell (bash or sh) found in this container\x1b[0m\r\n"})
	case ctx.Err() != nil:
		// Client closed the connection -- nothing to report.
	default:
		log.Warn().Err(execErr).Str("namespace", namespace).Str("pod", pod).Str("container", container).Msg("exec session error")
		sendMsg(termMsg{Type: "output", Data: fmt.Sprintf("\r\n\x1b[31m[session error: %s]\x1b[0m\r\n", execErr.Error())})
	}
}
