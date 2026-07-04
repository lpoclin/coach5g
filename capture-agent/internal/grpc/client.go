package grpc

import (
	"context"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"

	"github.com/lpoclin/coach5g/capture-agent/internal/pb"
)

// Client wraps the gRPC connection to api-server and maintains a streaming RPC.
type Client struct {
	mu     sync.Mutex
	conn   *grpc.ClientConn
	stub   pb.CaptureServiceClient
	stream pb.CaptureService_StreamPacketsClient
	addr   string
	podIP  string // own pod IP injected via POD_IP env, sent in every batch
}

// NewClient dials api-server at addr. dialCreds is always a fully-formed,
// non-nil credentials value -- insecure.NewCredentials() for today's
// plaintext default, or real TLS credentials when grpc.tls.enabled is set
// (see cmd/agent/main.go). This package has no TLS-specific branching of its
// own.
func NewClient(addr string, dialCreds credentials.TransportCredentials) (*Client, error) {
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(dialCreds),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		return nil, err
	}
	return &Client{
		conn:  conn,
		stub:  pb.NewCaptureServiceClient(conn),
		addr:  addr,
		podIP: os.Getenv("POD_IP"),
	}, nil
}

// SendBatch sends a batch of packets to the api-server over a persistent stream.
// If the stream is broken it is re-opened automatically.
func (c *Client) SendBatch(ctx context.Context, sessionID string, pkts []*pb.Packet) error {
	if len(pkts) == 0 {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.stream == nil {
		stream, err := c.stub.StreamPackets(ctx)
		if err != nil {
			log.Warn().Err(err).Str("addr", c.addr).Msg("grpc open stream failed")
			return err
		}
		c.stream = stream
		log.Debug().Str("session", sessionID).Int("goroutines", runtime.NumGoroutine()).Msg("grpc stream opened")
	}

	err := c.stream.Send(&pb.PacketBatch{
		Packets:   pkts,
		SessionId: sessionID,
		PodIp:     c.podIP,
	})
	if err != nil {
		log.Warn().Err(err).Msg("grpc send failed; will reopen stream")
		_ = c.stream.CloseSend()
		log.Debug().Str("session", sessionID).Int("goroutines", runtime.NumGoroutine()).Msg("grpc stream closed via CloseSend")
		c.stream = nil
		return err
	}
	return nil
}

// Close tears down the gRPC connection.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stream != nil {
		_, _ = c.stream.CloseAndRecv()
		c.stream = nil
	}
	return c.conn.Close()
}

// BackoffRetry wraps SendBatch with simple exponential backoff (up to 30s).
func (c *Client) BackoffRetry(ctx context.Context, sessionID string, pkts []*pb.Packet) {
	delay := time.Second
	for attempt := 0; attempt < 5; attempt++ {
		if err := c.SendBatch(ctx, sessionID, pkts); err == nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay < 30*time.Second {
			delay *= 2
		}
	}
}
