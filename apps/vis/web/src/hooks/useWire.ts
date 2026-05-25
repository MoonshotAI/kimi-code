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

/**
 * Subagent wire is now served by the same `/api/sessions/:id/wire?agent=...`
 * endpoint as the main agent — this hook is a thin alias kept for legacy
 * call sites (Phase D will inline `useWire` and drop this).
 */
export function useSubagentWire(
  sessionId: string | undefined,
  agentId: string | undefined,
  enabled = true,
) {
  return useWire(sessionId, agentId, enabled);
}

/**
 * Archives no longer exist in the new wire protocol. This stub is here so
 * Phase D-scope call sites (FilesTab) still type-check; the hook always
 * resolves to an empty payload.
 *
 * @deprecated will be removed when FilesTab is rewritten in Phase D.
 */
export function useArchive(_sessionId: string | undefined, _filename: string | undefined) {
  return useQuery({
    queryKey: ['archive', 'unavailable'] as const,
    queryFn: () => Promise.resolve<{ content: string }>({ content: '' }),
    enabled: false,
  });
}
