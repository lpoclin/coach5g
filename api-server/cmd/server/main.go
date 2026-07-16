package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"k8s.io/client-go/kubernetes"

	"github.com/lpoclin/coach5g/api-server/internal/capture"
	"github.com/lpoclin/coach5g/api-server/internal/grpctls"
	"github.com/lpoclin/coach5g/api-server/internal/handlers"
	"github.com/lpoclin/coach5g/api-server/internal/k8s"
	"github.com/lpoclin/coach5g/api-server/internal/k8s/coreprofile"
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

	// Allowed CORS/WebSocket origins. Always includes http/https of the
	// Gateway hostname (see helm/templates/api-server-deployment.yaml); an
	// operator can append more via values.yaml's allowedOrigins. An origin
	// not in this list is never echoed back or accepted -- see
	// corsMiddleware and internal/handlers' shared WebSocket upgrader.
	allowedOrigins := parseAllowedOrigins(envOr("ALLOWED_ORIGINS", ""))

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
	r.Use(corsMiddleware(allowedOrigins))
	r.Use(loggerMiddleware())

	// Health / readiness
	r.GET("/health", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	r.GET("/ready",  func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	// ── REST handlers ────────────────────────────────────────────────────────
	// ── Capture gRPC server ──────────────────────────────────────────────────
	// gRPC TLS (internal api-server <-> capture-agent channel) — disabled by
	// default. When enabled, serverCreds authenticates the StreamPackets
	// listener (mTLS, standard hostname verification since capture-agent
	// dials api-server by its stable Service DNS name), and agentCreds
	// authenticates outbound dials to a capture-agent's control server at an
	// ephemeral pod IP (custom verification, since hostname/IP matching
	// doesn't apply there — see internal/grpctls for why). Both default to
	// plaintext so the capture package never needs to know TLS exists.
	var serverCreds credentials.TransportCredentials = insecure.NewCredentials()
	var agentCreds credentials.TransportCredentials = insecure.NewCredentials()
	if os.Getenv("GRPC_TLS_ENABLED") == "true" {
		certFile := envOr("GRPC_TLS_CERT_FILE", "/etc/coach5g/grpc-tls/tls.crt")
		keyFile := envOr("GRPC_TLS_KEY_FILE", "/etc/coach5g/grpc-tls/tls.key")
		caFile := envOr("GRPC_TLS_CA_FILE", "/etc/coach5g/grpc-tls/ca.crt")
		agentIdentity := envOr("GRPC_TLS_CAPTURE_AGENT_IDENTITY", "coach5g-capture-agent")

		serverCreds, err = grpctls.ServerCredentials(certFile, keyFile, caFile)
		if err != nil {
			log.Fatal().Err(err).Msg("grpc tls: server credentials init failed")
		}
		agentCreds, err = grpctls.CaptureAgentCredentials(certFile, keyFile, caFile, agentIdentity)
		if err != nil {
			log.Fatal().Err(err).Msg("grpc tls: capture-agent client credentials init failed")
		}
		log.Info().Msg("grpc tls: enabled for api-server <-> capture-agent channel")
	}
	captureServer := capture.NewServer(serverCreds, agentCreds)
	grpcAddr := envOr("GRPC_ADDR", ":9999")
	go func() {
		if err := captureServer.ListenAndServe(grpcAddr); err != nil {
			log.Error().Err(err).Msg("capture gRPC server exited")
		}
	}()

	// ── Core profile ─────────────────────────────────────────────────────────
	// CORE_PROFILE selects which 5G core's NF-classification/topology-edge
	// conventions to use (see docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md).
	dnnMapOverride, err := parseDNNMapOverride(envOr("DNN_MAP_OVERRIDE", ""))
	if err != nil {
		log.Fatal().Err(err).Msg("invalid DNN_MAP_OVERRIDE")
	}

	coreProfileName := envOr("CORE_PROFILE", "free5gc")
	var coreProfile coreprofile.CoreProfile
	switch coreProfileName {
	case "free5gc":
		coreProfile = coreprofile.NewFree5GCProfile(dnnMapOverride)
	case "open5gs":
		coreProfile = coreprofile.NewOpen5GSProfile()
	default:
		log.Fatal().Str("CORE_PROFILE", coreProfileName).Msg("unrecognized core profile")
	}

	topoH    := handlers.NewTopologyHandler(k8sClient, targetNamespaces, coreProfile)
	logsH    := handlers.NewLogsHandler(lokiClient)
	metH     := handlers.NewMetricsHandler(promClient, captureServer, k8sClient)
	infraH   := handlers.NewInfraHandler(k8sClient, promClient)
	packetsH := handlers.NewPacketsHandler(captureServer)

	// ── Exec-per-pod terminal (Addition 4) ──────────────────────────────────
	// Off by default. When enabled, uses a dedicated, exec-only ServiceAccount
	// token (separate from k8sClient's cluster-wide read-only one) mounted at
	// EXEC_SA_TOKEN_FILE -- Kubernetes RBAC on that ServiceAccount is the sole
	// authorization boundary for this feature. See
	// docs/RISK_ASSESSMENT_ADDITIONS.md Addition 4 and
	// docs/EXEC_IDENTITY_ASSESSMENT.md.
	var execH *handlers.ExecHandler
	if os.Getenv("EXEC_TERMINAL_ENABLED") == "true" {
		tokenFile := envOr("EXEC_SA_TOKEN_FILE", "/etc/coach5g/exec-token/token")
		execConfig, err := k8s.NewExecConfig(tokenFile)
		if err != nil {
			log.Fatal().Err(err).Msg("exec terminal: rest config init failed")
		}
		execClient, err := kubernetes.NewForConfig(execConfig)
		if err != nil {
			log.Fatal().Err(err).Msg("exec terminal: clientset init failed")
		}
		execH = handlers.NewExecHandler(execClient, execConfig)
		log.Info().Msg("exec terminal: enabled")
	}

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
	if execH != nil {
		r.GET("/ws/exec/:namespace/:pod/:container", execH.HandleExec)
	}

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

// parseDNNMapOverride decodes DNN_MAP_OVERRIDE (namespace -> UPF `nf` label ->
// DNN name), JSON-encoded by the Helm chart from values.yaml's
// targets[].dnnMap. Empty/unset is the default, zero-configuration case.
func parseDNNMapOverride(raw string) (map[string]map[string]string, error) {
	m := map[string]map[string]string{}
	if raw == "" {
		return m, nil
	}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	return m, nil
}

// parseAllowedOrigins splits a comma-separated origin list, trimming
// whitespace and dropping empty entries.
func parseAllowedOrigins(raw string) []string {
	var out []string
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	return out
}

// originAllowed reports whether origin is an exact match for one of the
// configured allowed origins.
func originAllowed(origin string, allowed []string) bool {
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

func corsMiddleware(allowedOrigins []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if origin := c.GetHeader("Origin"); origin != "" && originAllowed(origin, allowedOrigins) {
			c.Header("Access-Control-Allow-Origin", origin)
		}
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
