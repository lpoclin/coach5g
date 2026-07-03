package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/coach5g/api-server/internal/capture"
	"github.com/lpoclin/coach5g/api-server/internal/handlers"
	"github.com/lpoclin/coach5g/api-server/internal/k8s"
	"github.com/lpoclin/coach5g/api-server/internal/loki"
	"github.com/lpoclin/coach5g/api-server/internal/prometheus"
)

func main() {
	// Structured logger — pretty in dev, JSON in prod
	if os.Getenv("GIN_MODE") == "release" {
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
	} else {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})
		zerolog.SetGlobalLevel(zerolog.DebugLevel)
	}

	// ── Kubernetes client ────────────────────────────────────────────────────
	k8sClient, err := k8s.NewClient()
	if err != nil {
		log.Fatal().Err(err).Msg("k8s client init failed")
	}

	// ── Upstream clients ─────────────────────────────────────────────────────
	lokiURL := envOr("LOKI_URL", "http://loki-gateway.loki")
	promURL := envOr("PROMETHEUS_URL", "http://kube-prometheus-stack-prometheus.monitoring:9090")

	targetNS := envOr("TARGET_NAMESPACES", "")
	var targetNamespaces []string
	for _, ns := range strings.Split(targetNS, ",") {
		if ns = strings.TrimSpace(ns); ns != "" {
			targetNamespaces = append(targetNamespaces, ns)
		}
	}

	lokiClient := loki.NewClient(lokiURL)
	promClient := prometheus.NewClient(promURL)

	// ── Gin router ───────────────────────────────────────────────────────────
	if os.Getenv("GIN_MODE") != "" {
		gin.SetMode(os.Getenv("GIN_MODE"))
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(corsMiddleware())
	r.Use(loggerMiddleware())

	// Health / readiness
	r.GET("/health", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	r.GET("/ready",  func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	// ── REST handlers ────────────────────────────────────────────────────────
	// ── Capture gRPC server ──────────────────────────────────────────────────
	captureServer := capture.NewServer()
	grpcAddr := envOr("GRPC_ADDR", ":9999")
	go func() {
		if err := captureServer.ListenAndServe(grpcAddr); err != nil {
			log.Error().Err(err).Msg("capture gRPC server exited")
		}
	}()

	topoH    := handlers.NewTopologyHandler(k8sClient, targetNamespaces)
	logsH    := handlers.NewLogsHandler(lokiClient)
	metH     := handlers.NewMetricsHandler(promClient, captureServer, k8sClient)
	infraH   := handlers.NewInfraHandler(k8sClient, promClient)
	packetsH := handlers.NewPacketsHandler(captureServer)

	api := r.Group("/api")
	{
		// Topology
		api.GET("/topology",                        topoH.GetTopology)
		api.GET("/namespaces",                      topoH.GetNamespaces)
		api.GET("/pods/:namespace",                 topoH.GetPods)
		api.GET("/pod/:namespace/:pod/interfaces",  topoH.GetPodInterfaces)

		// Logs
		api.GET("/logs/:namespace/:pod", logsH.GetLogs)

		// Metrics
		api.GET("/metrics/cluster",                 metH.GetClusterMetrics)
		api.GET("/metrics/timeseries",              metH.GetTimeSeries)
		api.GET("/metrics/pod/:namespace/:pod",     metH.GetPodMetrics)
		api.GET("/metrics/interface",               metH.GetInterfaceMetrics)
		api.GET("/metrics/active",                  metH.GetActiveTraffic)
		api.GET("/metrics/pods",                    metH.GetPodsUtilization)

		// Infrastructure
		api.GET("/nodes",           infraH.GetNodes)
		api.GET("/cluster-info",    infraH.GetClusterInfo)
		api.GET("/events",          infraH.GetEvents)
		api.GET("/events/:namespace", infraH.GetEvents)
		api.GET("/pvcs",            infraH.GetPVCs)
		api.GET("/namespace-stats", infraH.GetNamespaceStats)

		// Packet decode (sharkd) and pcap export
		api.GET("/packet/decode",    handlers.DecodePacketHandler(captureServer))
		api.GET("/packets/export",   handlers.ExportPacketsHandler(captureServer))

		// Static config
		api.GET("/config", handlers.ConfigHandler)
	}

	// ── WebSocket handlers ───────────────────────────────────────────────────
	r.GET("/ws/topology",                      topoH.WatchTopology)
	r.GET("/ws/logs/:namespace/:pod",          logsH.StreamLogs)
	r.GET("/ws/packets",                       packetsH.StreamPacketsQuery)   // always-live: ?pod=&interface=
	r.GET("/ws/packets/:node/:pod/:interface", packetsH.StreamPackets)        // legacy path-param form
	r.GET("/ws/terminal",                      handlers.TerminalHandler)

	// ── HTTP server ──────────────────────────────────────────────────────────
	addr := envOr("LISTEN_ADDR", ":8080")
	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0, // WS needs unlimited
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Info().Str("addr", addr).Msg("coach5g api-server starting")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server failed")
		}
	}()

	// ── Graceful shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("shutting down…")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("shutdown error")
	}
	log.Info().Msg("goodbye")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func loggerMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Debug().
			Str("method", c.Request.Method).
			Str("path", c.Request.URL.Path).
			Int("status", c.Writer.Status()).
			Dur("dur", time.Since(start)).
			Msg("request")
	}
}
