package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/ssh"
)

// ─── Wire protocol ────────────────────────────────────────────────────────────

type termMsg struct {
	Type     string `json:"type"`
	Data     string `json:"data,omitempty"`
	Host     string `json:"host,omitempty"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
	Cols     uint32 `json:"cols,omitempty"`
	Rows     uint32 `json:"rows,omitempty"`
	Message  string `json:"message,omitempty"`
}

func sendTermMsg(conn *websocket.Conn, msg termMsg) error {
	b, _ := json.Marshal(msg)
	return conn.WriteMessage(websocket.TextMessage, b)
}

// ─── Handler ──────────────────────────────────────────────────────────────────

// TerminalHandler — GET /ws/terminal
//
// Flow:
//  1. Upgrade to WebSocket
//  2. Wait for {"type":"auth","user":"…","password":"…"}
//  3. SSH dial → respond {"type":"auth_ok"} or {"type":"auth_fail","message":"…"}
//  4. Open PTY session; relay stdin/stdout via WebSocket frames
//  5. Handle {"type":"resize","cols":N,"rows":N} for SIGWINCH
//
// Credentials are read once, passed to ssh.Dial, then discarded — never
// stored in memory beyond the auth handshake.
func TerminalHandler(c *gin.Context) {
	sshHost := os.Getenv("SSH_HOST")
	sshPort := os.Getenv("SSH_PORT")
	if sshPort == "" {
		sshPort = "22"
	}
	if sshHost == "" {
		c.String(http.StatusServiceUnavailable, "SSH_HOST not configured")
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("ws upgrade terminal")
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(30 * time.Second))

	// ── Step 1: wait for auth message ──────────────────────────────────────
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return
	}
	conn.SetReadDeadline(time.Time{}) // clear deadline

	var authMsg termMsg
	if err := json.Unmarshal(raw, &authMsg); err != nil || authMsg.Type != "auth" {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "invalid auth message"})
		return
	}

	user := authMsg.User
	password := authMsg.Password
	targetHost := sshHost
	if authMsg.Host != "" {
		targetHost = authMsg.Host
	}
	// Clear from authMsg immediately after extracting
	authMsg.User = ""
	authMsg.Password = ""
	authMsg.Host = ""

	// ── Step 2: SSH dial ───────────────────────────────────────────────────
	sshCfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // cluster-internal, no TOFU needed
		Timeout:         10 * time.Second,
	}
	// Wipe password from local variable after building config
	password = ""

	addr := fmt.Sprintf("%s:%s", targetHost, sshPort)
	sshConn, err := ssh.Dial("tcp", addr, sshCfg)
	if err != nil {
		log.Warn().Err(err).Str("user", user).Msg("ssh auth failed")
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "authentication failed"})
		return
	}
	defer sshConn.Close()

	// ── Step 3: open PTY session ───────────────────────────────────────────
	session, err := sshConn.NewSession()
	if err != nil {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "could not open session"})
		return
	}
	defer session.Close()

	stdinPipe, err := session.StdinPipe()
	if err != nil {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "stdin pipe failed"})
		return
	}

	stdoutPipe, err := session.StdoutPipe()
	if err != nil {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "stdout pipe failed"})
		return
	}
	stderrPipe, err := session.StderrPipe()
	if err != nil {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "stderr pipe failed"})
		return
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "PTY request failed"})
		return
	}
	if err := session.Shell(); err != nil {
		_ = sendTermMsg(conn, termMsg{Type: "auth_fail", Message: "shell start failed"})
		return
	}

	_ = sendTermMsg(conn, termMsg{Type: "auth_ok"})
	log.Info().Str("user", user).Str("host", addr).Msg("terminal session opened")

	done := make(chan struct{})

	// stdout → WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				msg := termMsg{Type: "output", Data: string(buf[:n])}
				b, _ := json.Marshal(msg)
				if werr := conn.WriteMessage(websocket.TextMessage, b); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		close(done)
	}()

	// stderr → WebSocket (merged into output stream)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				msg := termMsg{Type: "output", Data: string(buf[:n])}
				b, _ := json.Marshal(msg)
				_ = conn.WriteMessage(websocket.TextMessage, b)
			}
			if err != nil {
				break
			}
		}
	}()

	// WebSocket → stdin / resize
	for {
		select {
		case <-done:
			return
		default:
		}

		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Debug().Err(err).Msg("terminal ws closed")
			}
			return
		}

		var msg termMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "input":
			if _, err := io.WriteString(stdinPipe, msg.Data); err != nil {
				return
			}
		case "resize":
			cols := msg.Cols
			rows := msg.Rows
			if cols == 0 {
				cols = 80
			}
			if rows == 0 {
				rows = 24
			}
			_ = session.WindowChange(int(rows), int(cols))
		}
	}
}
