package capture

import "sync"

// RingBuffer is a thread-safe circular packet buffer.
type RingBuffer struct {
	mu   sync.RWMutex
	buf  []RawPacket
	head int
	size int
	cap  int
}

// RawPacket holds a decoded packet entry.
type RawPacket struct {
	TimestampNs int64
	SrcIP       string
	DstIP       string
	SrcPort     uint32
	DstPort     uint32
	Protocol    string
	Length      uint32
	Info        string
	Raw         []byte
}

func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		buf: make([]RawPacket, capacity),
		cap: capacity,
	}
}

// Push adds a packet to the ring. If full, overwrites the oldest.
func (r *RingBuffer) Push(pkt RawPacket) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf[r.head].Raw = nil // release old raw bytes before overwrite
	r.buf[r.head] = pkt
	r.head = (r.head + 1) % r.cap
	if r.size < r.cap {
		r.size++
	}
}

// Snapshot returns a copy of all packets in insertion order.
func (r *RingBuffer) Snapshot() []RawPacket {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.size == 0 {
		return nil
	}
	out := make([]RawPacket, r.size)
	if r.size < r.cap {
		copy(out, r.buf[:r.size])
	} else {
		// head points to oldest
		copy(out, r.buf[r.head:])
		copy(out[r.cap-r.head:], r.buf[:r.head])
	}
	return out
}

// Len returns the number of packets currently in the buffer.
func (r *RingBuffer) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.size
}
