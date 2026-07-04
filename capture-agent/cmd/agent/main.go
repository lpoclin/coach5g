package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/lpoclin/coach5g/capture-agent/internal/capture"
	"github.com/lpoclin/coach5g/capture-agent/internal/control"
	"github.com/lpoclin/coach5g/capture-agent/internal/discovery"
	agentgrpc "github.com/lpoclin/coach5g/capture-agent/internal/grpc"
	"github.com/lpoclin/coach5g/capture-agent/internal/grpctls"
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})
	zerolog.SetGlobalLevel(zerolog.InfoLevel)

	apiServerAddr := envOr("API_SERVER_ADDR", "coach5g-api:9999")
	targetNS      := envOr("TARGET_NAMESPACES", "free5gc")
	nodeNameStr   := envOr("NODE_NAME", "")

	log.Info().
		Str("apiServer", apiServerAddr).
		Str("namespaces", targetNS).
		Str("node", nodeNameStr).
		Msg("capture-agent starting")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// gRPC TLS (internal api-server <-> capture-agent channel) — disabled by
	// default. When enabled, clientCreds authenticates the outbound dial to
	// api-server's stable Service DNS name (standard mTLS), and serverCreds
	// authenticates capture-agent's own control listener against inbound
	// dials from api-server (standard mTLS — capture-agent is the server in
	// that direction, so no custom verification is needed here; see
	// internal/grpctls for the one place that IS needed, on api-server's
	// side). Both default to plaintext so the grpc/control packages never
	// need to know TLS exists.
	var clientCreds credentials.TransportCredentials = insecure.NewCredentials()
	var serverCreds credentials.TransportCredentials = insecure.NewCredentials()
	if envOr("GRPC_TLS_ENABLED", "false") == "true" {
		certFile := envOr("GRPC_TLS_CERT_FILE", "/etc/coach5g/grpc-tls/tls.crt")
		keyFile := envOr("GRPC_TLS_KEY_FILE", "/etc/coach5g/grpc-tls/tls.key")
		caFile := envOr("GRPC_TLS_CA_FILE", "/etc/coach5g/grpc-tls/ca.crt")

		var tlsErr error
		clientCreds, tlsErr = grpctls.APIServerCredentials(certFile, keyFile, caFile)
		if tlsErr != nil {
			log.Fatal().Err(tlsErr).Msg("grpc tls: api-server client credentials init failed")
		}
		serverCreds, tlsErr = grpctls.ServerCredentials(certFile, keyFile, caFile)
		if tlsErr != nil {
			log.Fatal().Err(tlsErr).Msg("grpc tls: control server credentials init failed")
		}
		log.Info().Msg("grpc tls: enabled for api-server <-> capture-agent channel")
	}

	// ── gRPC client to api-server ────────────────────────────────────────────
	grpcClient, err := agentgrpc.NewClient(apiServerAddr, clientCreds)
	if err != nil {
		log.Fatal().Err(err).Msg("grpc client init failed")
	}
	defer grpcClient.Close()

	// ── Pod discovery loop ───────────────────────────────────────────────────
	disc, err := discovery.NewDiscovery(splitNS(targetNS), nodeNameStr)
	if err != nil {
		log.Fatal().Err(err).Msg("discovery init failed")
	}

	// ── Capture manager ──────────────────────────────────────────────────────
	capMgr := capture.NewManager(grpcClient)

	// ── Control gRPC server (api-server → capture-agent) ─────────────────────
	controlAddr := envOr("CONTROL_ADDR", ":9998")
	controlServer := control.NewServer(capMgr, serverCreds)
	go func() {
		if err := controlServer.ListenAndServe(controlAddr); err != nil {
			log.Error().Err(err).Msg("control server exited")
		}
	}()

	go disc.Run(ctx, func(pods []discovery.PodInfo) {
		capMgr.Reconcile(ctx, pods)
	})

	// ── Graceful shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Info().Msg("shutting down capture-agent")
	cancel()
	capMgr.StopAll()
	controlServer.GracefulStop()
	log.Info().Msg("goodbye")
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func splitNS(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
		} else {
			cur += string(c)
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
