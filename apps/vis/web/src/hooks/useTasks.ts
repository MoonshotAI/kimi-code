import { useQuery } from '@tanstack/react-query';

import { api } from '../api';

/** Background tasks for a session (process / agent / question), with
 *  `output.log` size metadata per task. */
export function useTasks(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', sessionId] as const,
    queryFn: () => api.getTasks(sessionId!),
    enabled: !!sessionId,
  });
}

/** Cron jobs scheduled within a session. */
export function useCron(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['cron', sessionId] as const,
    queryFn: () => api.getCron(sessionId!),
    enabled: !!sessionId,
  });
}

/** Parsed diagnostic log for a session (session or global). */
export function useLogs(sessionId: string | undefined, which: 'session' | 'global') {
  return useQuery({
    queryKey: ['logs', sessionId, which] as const,
    queryFn: () => api.getLogs(sessionId!, which),
    enabled: !!sessionId,
  });
}
