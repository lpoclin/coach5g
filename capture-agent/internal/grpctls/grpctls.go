// Package grpctls builds gRPC transport credentials for the internal
// api-server <-> capture-agent channel from PEM files mounted from a
// cert-manager-issued (or manually created) Kubernetes Secret. Credentials
// are constructed once at process startup and passed into the control and
// grpc packages' constructors, which have no TLS-specific logic of their
// own.
package grpctls

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"google.golang.org/grpc/credentials"
)

// ServerCredentials loads a certificate/key pair and CA bundle from disk and
// returns mTLS server credentials for capture-agent's own control listener
// (:9998), which requires and verifies api-server's client certificate
// against the CA pool. No custom verification is needed here: capture-agent
// is the server in this direction, so standard mTLS applies.
func ServerCredentials(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load server keypair: %w", err)
	}
	caPool, err := loadCAPool(caFile)
	if err != nil {
		return nil, err
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    caPool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
	}), nil
}

// APIServerCredentials loads a certificate/key pair and CA bundle from disk
// and returns client credentials for dialing api-server's stable Service DNS
// name (StreamPackets ingest, :9999). Standard hostname-based server-cert
// verification applies here: the dial target is a DNS name matching the
// certificate's SAN, so no custom verification is required.
func APIServerCredentials(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client keypair: %w", err)
	}
	caPool, err := loadCAPool(caFile)
	if err != nil {
		return nil, err
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS12,
	}), nil
}

func loadCAPool(caFile string) (*x509.CertPool, error) {
	pemBytes, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA file: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, fmt.Errorf("no valid certificates found in %s", caFile)
	}
	return pool, nil
}
