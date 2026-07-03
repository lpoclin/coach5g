package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/lpoclin/coach5g/api-server/internal/capture"
)

func ConfigHandler(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ringBufferSize": capture.PktRingCap})
}
