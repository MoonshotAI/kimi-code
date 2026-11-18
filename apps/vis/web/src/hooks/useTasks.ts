import { useQuery } from '@tanstack/react-query';

import { api } from '../api';

export function useTasks(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', sessionId] as const,
    queryFn: () => api.getTasks(sessionId!),
    enabled: !!sessionId,
  });
}

export function useCron(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['cron', sessionId] as const,
    queryFn: () => api.getCron(sessionId!),
    enabled: !!sessionId,
  });
}

export function useLogs(sessionId: string | undefined, which: 'session' | 'global') {
  return useQuery({
    queryKey: ['logs', sessionId, which] as const,
    queryFn: () => api.getLogs(sessionId!, which),
    enabled: !!sessionId,
  });
}
