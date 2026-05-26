import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useWire(
  sessionId: string | undefined,
  agentId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['session', sessionId, 'wire', agentId] as const,
    queryFn: () => api.getWire(sessionId!, agentId!),
    enabled: !!sessionId && !!agentId && enabled,
  });
}
