import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useAgentTree(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['session', sessionId, 'agents'] as const,
    queryFn: () => api.getAgentTree(sessionId!),
    enabled: !!sessionId && enabled,
  });
}
