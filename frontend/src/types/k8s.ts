export interface K8sNode {
  name: string
  role: string
  status: 'Ready' | 'NotReady' | 'Unknown'
  ip: string
  cpu: {
    capacity: number
    allocatable: number
    used: number
    percent: number
  }
  memory: {
    capacityBytes: number
    allocatableBytes: number
    usedBytes: number
    percent: number
  }
  disk: {
    capacityBytes: number
    usedBytes: number
    percent: number
  }
  kubeletVersion: string
  osImage: string
  podCount: number
  podCapacity: number
  createdAt: string
  // Stack info (Fix E)
  kernelVersion:    string
  containerRuntime: string
  architecture:     string
  cpuCores:         number
  totalMemoryGiB:   number
}

export interface ClusterInfo {
  hypervisor:       string
  cniPrimary:       string
  cniSecondary:     string
  clusterCreatedAt?: string
}

export interface K8sEvent {
  name: string
  namespace: string
  type: 'Normal' | 'Warning'
  reason: string
  message: string
  involvedObject: {
    kind: string
    name: string
    namespace: string
  }
  count: number
  firstTime: string
  lastTime: string
}

export interface K8sPVC {
  name: string
  namespace: string
  status: 'Bound' | 'Pending' | 'Lost'
  capacity: string
  storageClass: string
  volumeName: string
  accessModes: string[]
}

export interface ClusterMetrics {
  cpuPercent: number
  memoryPercent: number
  podsRunning: number
  podsTotal: number
  nodesReady: number
  nodesTotal: number
  pvcsTotal: number
  pvcsBound: number
}

export interface NamespaceStats {
  namespace: string
  running: number
  pending: number
  failed: number
  restarting: number
}

export interface TimeSeriesPoint {
  timestamp: number
  value: number
}

export interface ClusterTimeSeries {
  cpuPercent: TimeSeriesPoint[]
  memoryPercent: TimeSeriesPoint[]
}

export interface PodMetricEntry {
  namespace: string
  pod: string
  cpuUsedM: number
  cpuLimitM: number
  ramUsedMi: number
  ramLimitMi: number
}
