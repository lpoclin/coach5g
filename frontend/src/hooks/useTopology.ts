import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/services/api'
import { getWSManager, closeWSManager } from '@/services/websocket'
import type { TopologyGraph } from '@/types/topology'

const POLL_MS = 5_000
const DEBOUNCE_MS = 250

export function useTopology() {
  const queryClient = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const query = useQuery<TopologyGraph>({
    queryKey: ['topology'],
    queryFn: () => api.topology.get(),
    refetchInterval: POLL_MS,
    staleTime: DEBOUNCE_MS,
    retry: 3,
  })

  useEffect(() => {
    const wsUrl = '/ws/topology'
    const mgr = getWSManager(wsUrl)

    const handle = (data: TopologyGraph) => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        queryClient.setQueryData(['topology'], data)
      }, DEBOUNCE_MS)
    }

    mgr.on<TopologyGraph>('topology', handle)
    return () => {
      mgr.off('topology', handle)
      closeWSManager(wsUrl)
      clearTimeout(debounceRef.current)
    }
  }, [queryClient])

  return query
}
