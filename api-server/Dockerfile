FROM golang:1.26-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /api-server ./cmd/server

# Runtime: Ubuntu with tshark (includes sharkd for packet decode)
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    tshark \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Allow tshark/sharkd to run without prompting
RUN groupadd -f wireshark && usermod -aG wireshark root

COPY --from=builder /api-server /api-server
EXPOSE 8080
ENTRYPOINT ["/api-server"]
