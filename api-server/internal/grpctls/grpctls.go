// Package grpctls builds gRPC transport credentials for the internal
// api-server <-> capture-agent channel from PEM files mounted from a
// cert-manager-issued (or manually created) Kubernetes Secret. Credentials
// are constructed once at process startup and passed into the capture
// package's constructors, which have no TLS-specific logic of their own.
package grpctls

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"google.golang.org/grpc/credentials"
)

// ServerCredentials loads a certificate/key pair and CA bundle from disk and
// returns mTLS server credentials for the StreamPackets listener (:9999),
// which requires and verifies capture-agent's client certificate against the
// CA pool.
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

// CaptureAgentCredentials loads a certificate/key pair and CA bundle from disk
// and returns client credentials for dialing a capture-agent's control server
// at an ephemeral pod IP. Standard hostname verification cannot be used here:
// the dial target is an IP address, not the fixed logical identity
// (expectedAgentIdentity) encoded in the certificate's SAN. Go's built-in
// address-based verification is disabled and replaced with a manual check:
// the presented certificate must still chain to the trusted CA, and its SAN
// must match expectedAgentIdentity exactly. This still authenticates the
// peer; it only skips the address-to-SAN match that doesn't apply when
// dialing by IP.
func CaptureAgentCredentials(certFile, keyFile, caFile, expectedAgentIdentity string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client keypair: %w", err)
	}
	caPool, err := loadCAPool(caFile)
	if err != nil {
		return nil, err
	}
	verify := func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		return verifyPeerAgainstCA(rawCerts, caPool, expectedAgentIdentity)
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		// Does not skip real verification -- only Go's default address-based
		// check, which can't work against an ephemeral pod IP.
		// VerifyPeerCertificate below does the actual chain + identity check.
		// Don't remove that callback while this stays true, or the
		// connection becomes unauthenticated.
		InsecureSkipVerify:    true,
		VerifyPeerCertificate: verify,
		MinVersion:            tls.VersionTLS12,
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

// verifyPeerAgainstCA manually verifies a presented certificate chain against
// caPool and checks the leaf certificate's DNS SAN includes expectedIdentity.
// Used when InsecureSkipVerify disables Go's built-in address-based checks.
func verifyPeerAgainstCA(rawCerts [][]byte, caPool *x509.CertPool, expectedIdentity string) error {
	if len(rawCerts) == 0 {
		return fmt.Errorf("no peer certificate presented")
	}
	leaf, err := x509.ParseCertificate(rawCerts[0])
	if err != nil {
		return fmt.Errorf("parse peer certificate: %w", err)
	}
	intermediates := x509.NewCertPool()
	for _, raw := range rawCerts[1:] {
		if c, err := x509.ParseCertificate(raw); err == nil {
			intermediates.AddCert(c)
		}
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         caPool,
		Intermediates: intermediates,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		return fmt.Errorf("peer certificate does not chain to trusted CA: %w", err)
	}
	for _, name := range leaf.DNSNames {
		if name == expectedIdentity {
			return nil
		}
	}
	return fmt.Errorf("peer certificate identity %v does not match expected %q", leaf.DNSNames, expectedIdentity)
}
