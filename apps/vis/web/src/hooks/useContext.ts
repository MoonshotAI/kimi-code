import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Fetch the projected context for a given agent in a session.
 *
 * The `/api/sessions/:id/context?agent=<agentId>` route returns the
 * full `ContextProjection` (messages, usage totals, config snapshot,
 * permission mode, plan mode). Defaults to `main` when no agent id
 * is provided, but callers should pass an explicit id for clarity.
 */
export function useContext(sessionId: string, agentId: string) {
  return useQuery({
    queryKey: ['context', sessionId, agentId] as const,
    queryFn: () => api.getContext(sessionId, agentId),
    enabled: sessionId.length > 0 && agentId.length > 0,
  });
}
