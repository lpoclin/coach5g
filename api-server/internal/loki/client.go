package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"
)

type Client struct {
	base string
	http *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		base: baseURL,
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

// lokiQueryResponse is the Loki query_range API response
type lokiQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Stream map[string]string `json:"stream"`
			Values [][]string        `json:"values"` // [timestamp, line]
		} `json:"result"`
	} `json:"data"`
}

// QueryLast fetches the last N log lines for a pod (most recent, returned in chronological order).
func (c *Client) QueryLast(ctx context.Context, namespace, pod string, limit int) ([]string, error) {
	query := fmt.Sprintf(`{namespace="%s", pod=~".*%s.*"}`, namespace, pod)
	return c.queryRange(ctx, query, time.Now().Add(-24*time.Hour), time.Now(), limit, "backward")
}

// QueryRange fetches log lines between two timestamps in chronological order.
func (c *Client) QueryRange(ctx context.Context, namespace, pod string, start, end time.Time) ([]string, error) {
	query := fmt.Sprintf(`{namespace="%s", pod=~".*%s.*"}`, namespace, pod)
	return c.queryRange(ctx, query, start, end, 500, "forward")
}

func (c *Client) queryRange(ctx context.Context, query string, start, end time.Time, limit int, direction string) ([]string, error) {
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	params.Set("end",   strconv.FormatInt(end.UnixNano(), 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("direction", direction)

	reqURL := fmt.Sprintf("%s/loki/api/v1/query_range?%s", c.base, params.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("loki request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("loki %d: %s", resp.StatusCode, string(body))
	}

	var result lokiQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("loki decode: %w", err)
	}

	// Flatten and sort all log lines by timestamp
	type entry struct {
		ts   int64
		line string
	}
	var entries []entry
	for _, stream := range result.Data.Result {
		for _, val := range stream.Values {
			if len(val) < 2 {
				continue
			}
			ts, _ := strconv.ParseInt(val[0], 10, 64)
			entries = append(entries, entry{ts: ts, line: val[1]})
		}
	}
	// backward queries return newest-first; sort to chronological order
	if direction == "backward" {
		sort.Slice(entries, func(i, j int) bool { return entries[i].ts > entries[j].ts })
		// reverse to get oldest-first for display
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
	} else {
		sort.Slice(entries, func(i, j int) bool { return entries[i].ts < entries[j].ts })
	}

	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		// Prepend ISO timestamp so the frontend can extract HH:MM:SS without parsing log content.
		// Format: "2006-01-02T15:04:05.000Z\tlog_line_text"
		ts := time.Unix(0, e.ts).UTC().Format("2006-01-02T15:04:05.000Z07:00")
		lines = append(lines, ts+"\t"+e.line)
	}
	return lines, nil
}
