// Package hubble provides a client for the Hubble Relay gRPC API.
// Used to detect active SBI flows for topology edge animation.
// Implementation is stubbed; full gRPC client to be wired in a later iteration.
package hubble

import (
	"context"

	"github.com/rs/zerolog/log"
)

type Client struct {
	address string
}

func NewClient(address string) *Client {
	return &Client{address: address}
}

// ActiveFlows returns a set of edge IDs that currently have traffic.
// In the stub, returns an empty set; wire to hubble-relay gRPC later.
func (c *Client) ActiveFlows(_ context.Context) (map[string]bool, error) {
	log.Debug().Str("address", c.address).Msg("hubble: stub ActiveFlows called")
	return map[string]bool{}, nil
}
