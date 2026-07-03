# Build stage
FROM golang:1.26-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux \
    go build -ldflags="-s -w" -o /capture-agent ./cmd/agent

# Runtime: Ubuntu with tcpdump + tshark
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    tcpdump \
    tshark \
    iproute2 \
    procps \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

# Allow tshark to capture without root (supplementary)
RUN groupadd -f wireshark && usermod -aG wireshark root

COPY --from=builder /capture-agent /capture-agent
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9999
ENTRYPOINT ["/entrypoint.sh"]
