export type Protocol =
  | 'GTP-U' | 'PFCP' | 'HTTP/2' | 'SCTP' | 'NGAP' | 'NAS'
  | 'DNS' | 'TCP' | 'UDP' | 'ICMP' | 'OTHER'

export interface Packet {
  no: number
  timestampNs: number
  srcIP: string
  dstIP: string
  srcPort: number
  dstPort: number
  protocol: Protocol
  length: number
  info: string
  raw?: Uint8Array
  interfaceName: string
  podName: string
  namespace: string
  node: string
}

export interface CaptureSession {
  id: string
  podName: string
  namespace: string
  node: string
  interfaceName: string
  startedAt: number
  status: 'connecting' | 'active' | 'paused' | 'stopped' | 'error'
  packetCount: number
}

export interface CaptureFilter {
  protocol?: Protocol | ''
  srcIP?: string
  dstIP?: string
  port?: number
  search?: string
}

export const PROTOCOL_COLORS: Record<Protocol, string> = {
  'GTP-U':  'proto-gtpu',
  'PFCP':   'proto-pfcp',
  'HTTP/2': 'proto-http2',
  'SCTP':   'proto-sctp',
  'NGAP':   'proto-sctp',
  'NAS':    'proto-nas',
  'DNS':    'proto-dns',
  'TCP':    'proto-other',
  'UDP':    'proto-other',
  'ICMP':   'proto-other',
  'OTHER':  'proto-other',
}
