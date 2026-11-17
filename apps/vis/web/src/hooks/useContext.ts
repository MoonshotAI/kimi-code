import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useContext(
  sessionId: string,
  agentId: string,
  mode: 'model' | 'full' = 'model',
) {
  return useQuery({
    queryKey: ['context', sessionId, agentId, mode] as const,
    queryFn: () => api.getContext(sessionId, agentId, mode),
    enabled: sessionId.length > 0 && agentId.length > 0,
  });
}
