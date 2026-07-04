package control

import (
	"context"
	"net"

	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"github.com/lpoclin/coach5g/capture-agent/internal/capture"
	"github.com/lpoclin/coach5g/capture-agent/internal/pb"
)

// Server implements the CaptureAgentControl gRPC service on capture-agent.
// EnableTshark and DisableTshark are stubs in Step 1; Step 2 wires them to the Manager.
type Server struct {
	pb.UnimplementedCaptureAgentControlServer
	manager    *capture.Manager
	grpcServer *grpc.Server
}

// NewServer creates the control server and registers it with a new gRPC
// server. The gRPC server is created here so GracefulStop() is always safe to
// call. serverCreds is used for the control listener -- callers always pass
// fully-formed, non-nil credentials (insecure.NewCredentials() for today's
// plaintext default, or real mTLS credentials when grpc.tls.enabled is set;
// see cmd/agent/main.go). This package has no TLS-specific branching of its
// own.
func NewServer(manager *capture.Manager, serverCreds credentials.TransportCredentials) *Server {
	srv := grpc.NewServer(grpc.Creds(serverCreds))
	s := &Server{manager: manager, grpcServer: srv}
	pb.RegisterCaptureAgentControlServer(srv, s)
	return s
}

// ListenAndServe binds addr and starts serving. Blocks until the server stops.
func (s *Server) ListenAndServe(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	log.Info().Str("addr", addr).Msg("capture-agent control server listening")
	return s.grpcServer.Serve(lis)
}

// GracefulStop drains in-flight RPCs and shuts down the server.
func (s *Server) GracefulStop() {
	s.grpcServer.GracefulStop()
}

func (s *Server) EnableTshark(_ context.Context, req *pb.TsharkRequest) (*pb.TsharkResponse, error) {
	if err := s.manager.EnableTshark(req.GetSessionId()); err != nil {
		log.Warn().Err(err).Str("session", req.GetSessionId()).Msg("EnableTshark failed")
		return &pb.TsharkResponse{Ok: false}, nil
	}
	log.Info().Str("session", req.GetSessionId()).Msg("tshark enabled")
	return &pb.TsharkResponse{Ok: true}, nil
}

func (s *Server) DisableTshark(_ context.Context, req *pb.TsharkRequest) (*pb.TsharkResponse, error) {
	if err := s.manager.DisableTshark(req.GetSessionId()); err != nil {
		log.Warn().Err(err).Str("session", req.GetSessionId()).Msg("DisableTshark failed")
		return &pb.TsharkResponse{Ok: false}, nil
	}
	log.Info().Str("session", req.GetSessionId()).Msg("tshark disabled")
	return &pb.TsharkResponse{Ok: true}, nil
}

func (s *Server) Ping(_ context.Context, _ *pb.PingRequest) (*pb.PingResponse, error) {
	return &pb.PingResponse{Ok: true}, nil
}
