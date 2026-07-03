export type NFType =
  | 'NRF' | 'AMF' | 'SMF' | 'AUSF' | 'UDM' | 'UDR'
  | 'PCF' | 'NSSF' | 'CHF' | 'NEF' | 'UPF' | 'iUPF'
  | 'gNB' | 'UE' | 'DN' | 'UNKNOWN'

export type Plane = 'sbi' | 'userplane' | 'ran' | 'pfcp' | 'management'

export type PodPhase = 'Running' | 'Pending' | 'Failed' | 'Succeeded' | 'Unknown'

export type PodCondition = 'Running' | 'CrashLoopBackOff' | 'OOMKilled' | 'Error' | 'Pending' | 'Unknown'

export interface PodStatus {
  phase: PodPhase
  ready: boolean
  condition: PodCondition
  restarts: number
}

export interface NetworkInterface {
  name: string
  interface: string
  ips: string[]
  mac?: string
  isDefault: boolean
}

export interface TopologyNode {
  id: string
  podName: string
  namespace: string
  nfType: NFType
  displayName: string
  nodeName: string
  nodeIP: string        // k8s node InternalIP (pod.status.hostIP) for Prometheus queries
  status: PodStatus
  interfaces: NetworkInterface[]
  age: string
  image: string
  labels: Record<string, string>
}

export interface TopologyEdge {
  id: string
  source: string
  target: string
  interface: string
  label: string
  plane: Plane
  srcIP?: string
  dstIP?: string
  hasTraffic?: boolean
  busEdge?: boolean   // SBI bus edge — drawn on canvas overlay, not as a Cytoscape edge
}

export interface TopologyGraph {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  updatedAt: string
  namespaces?: string[]
  primaryCNI?: string
  secondaryCNI?: string
}

// Position hints per NF type for the preset layout
export const NF_POSITIONS: Record<NFType, { x: number; y: number }> = {
  NRF:     { x: 0,    y: 0   },
  AMF:     { x: -350, y: 0   },
  SMF:     { x: 350,  y: 0   },
  AUSF:    { x: -600, y: -80 },
  UDM:     { x: -500, y: 80  },
  UDR:     { x: -500, y: 200 },
  PCF:     { x: 500,  y: 80  },
  NSSF:    { x: 600,  y: -80 },
  CHF:     { x: 350,  y: 200 },
  NEF:     { x: -150, y: 200 },
  gNB:     { x: -350, y: 480 },
  iUPF:    { x: 0,    y: 600 },
  UPF:     { x: 250,  y: 600 },
  UE:      { x: -600, y: 480 },
  DN:      { x: 0,    y: 920 },
  UNKNOWN: { x: 700,  y: 0   },
}

export const PLANE_COLORS: Record<Plane, string> = {
  sbi:        '#3b82f6',
  userplane:  '#22c55e',
  ran:        '#f97316',
  pfcp:       '#a855f7',
  management: '#6b7280',
}

export const NF_PLANE: Record<NFType, Plane> = {
  NRF:     'sbi',
  AMF:     'sbi',
  SMF:     'sbi',
  AUSF:    'sbi',
  UDM:     'sbi',
  UDR:     'sbi',
  PCF:     'sbi',
  NSSF:    'sbi',
  CHF:     'sbi',
  NEF:     'sbi',
  UPF:     'userplane',
  iUPF:    'userplane',
  gNB:     'ran',
  UE:      'ran',
  DN:      'management',
  UNKNOWN: 'management',
}
