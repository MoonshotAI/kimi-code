import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { SessionSummary } from '../types';

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'] as const,
    queryFn: () => api.listSessions(),
  });
}

export function useSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['session', sessionId] as const,
    queryFn: () => api.getSession(sessionId!),
    enabled: !!sessionId,
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.deleteSession(sessionId),
    onSuccess: (_result, sessionId) => {
      qc.setQueryData<SessionSummary[]>(['sessions'], (old) =>
        old?.filter((s) => s.sessionId !== sessionId),
      );
      qc.removeQueries({ queryKey: ['session', sessionId] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** Import a debug zip; refreshes the session list on success. */
export function useImportZip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.importZip(file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
