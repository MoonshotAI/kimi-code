import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Fetch the projected context for a given agent in a session.
 *
 * The `/api/sessions/:id/context?agent=<agentId>` route returns the
 * full `ContextProjection` (messages, usage totals, contextTokens,
 * config snapshot, permission mode, plan mode, goal, swarm). Defaults
 * to `main` when no agent id is provided, but callers should pass an
 * explicit id for clarity.
 *
 * `mode` selects the projection view: `'model'` (default) mirrors what
 * the model currently sees (post-compaction/undo/clear), while `'full'`
 * requests the full reconstructed history for debugging. Both modes are
 * cached independently (the mode is part of the React Query key).
 */
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
