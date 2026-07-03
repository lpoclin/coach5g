package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/coach5g/api-server/internal/loki"
)

type LogsHandler struct {
	loki *loki.Client
}

func NewLogsHandler(l *loki.Client) *LogsHandler {
	return &LogsHandler{loki: l}
}

// GET /api/logs/:namespace/:pod?lines=500
func (h *LogsHandler) GetLogs(c *gin.Context) {
	ns := c.Param("namespace")
	pod := c.Param("pod")
	lines := 500
	if l := c.Query("lines"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 5000 {
			lines = n
		}
	}

	logLines, err := h.loki.QueryLast(c.Request.Context(), ns, pod, lines)
	if err != nil {
		log.Warn().Err(err).Str("pod", pod).Msg("loki query")
		c.JSON(http.StatusOK, []string{}) // soft failure
		return
	}
	c.JSON(http.StatusOK, logLines)
}

// GET /ws/logs/:namespace/:pod  — real-time log stream
func (h *LogsHandler) StreamLogs(c *gin.Context) {
	ns := c.Param("namespace")
	pod := c.Param("pod")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("ws upgrade logs")
		return
	}
	defer conn.Close()

	// Tail mode: stream new lines every 2 seconds via Loki tail API
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	var since time.Time

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Send last 200 lines on connect
	initial, _ := h.loki.QueryLast(c.Request.Context(), ns, pod, 200)
	if len(initial) > 0 {
		_ = conn.WriteJSON(map[string]interface{}{"type": "log_lines", "data": initial})
		since = time.Now()
	} else {
		since = time.Now().Add(-5 * time.Minute)
	}

	for {
		select {
		case <-done:
			return
		case t := <-ticker.C:
			lines, err := h.loki.QueryRange(c.Request.Context(), ns, pod, since, t)
			if err == nil && len(lines) > 0 {
				_ = conn.WriteJSON(map[string]interface{}{"type": "log_lines", "data": lines})
				since = t
			}
			_ = conn.WriteMessage(1, []byte(fmt.Sprintf(`{"type":"heartbeat","ts":%d}`, t.UnixMilli())))
		}
	}
}
