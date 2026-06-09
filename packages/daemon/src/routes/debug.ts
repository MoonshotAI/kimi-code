/**
 * `/debug/*` REST routes.
 *
 * Only mounted when `startDaemon({debugEndpoints: true})`. The CLI never
 * sets that option, so production daemons don't expose this surface.
 * Tests (daemon-e2e + in-process) flip it on to assert internals
 * that the user-facing surface can't reveal:
 *
 *   GET /debug/prompts/{sid}/state         data: AgentStateSnapshot | null
 *   GET /debug/prompts/{sid}/dispatch-log  data: { entries: PromptDispatchLogEntry[] }
 *
 * Why expose these:
 *
 * The stateless-controls diff dispatch suppresses redundant `core.rpc.*`
 * setter calls against a per-session shadow. The WS `agent.status.updated`
 * frame broadcasts the resulting state but says nothing about WHETHER the
 * setter actually ran — a no-op submit and a redundant re-dispatch produce
 * the same WS surface. To prove the suppression really happened, e2e tests
 * need to see the dispatch ring buffer directly.
 *
 * Read-only, no auth, no mutation. Both endpoints return `null` data (state)
 * or empty array (dispatch-log) when the session has never bootstrapped.
 *
 * **Anti-corruption**: we resolve `IPromptService` via the accessor and
 * cast to the concrete `PromptService` class to reach the underscore-
 * prefixed `_agentStateForTest` / `_dispatchLogForTest` accessors. Same
 * pattern `packages/daemon/test/prompt.e2e.test.ts` already uses.
 */

import { IPromptService, PromptService } from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface DebugRouteHost {
  get(
    path: string,
    options:
      | { preHandler: unknown[]; schema?: Record<string, unknown> }
      | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

export function registerDebugRoutes(
  app: DebugRouteHost,
  ix: IInstantiationService,
): void {
  // GET /debug/prompts/{session_id}/state --------------------------------
  const debugPromptStateRoute = defineRoute(
    {
      method: 'GET',
      path: '/debug/prompts/{session_id}/state',
      params: sessionIdParamSchema,
    },
    async (req, reply) => {
      const { session_id: sid } = req.params;
      const prompts = ix.invokeFunction((a) => a.get(IPromptService)) as PromptService;
      // `_agentStateForTest` returns `undefined` before the first submit.
      // Surface that as JSON `null` so the wire shape stays explicit.
      const snap = prompts._agentStateForTest(sid) ?? null;
      reply.send(okEnvelope(snap, req.id));
    },
  );
  app.get(
    debugPromptStateRoute.path,
    debugPromptStateRoute.options,
    debugPromptStateRoute.handler as Parameters<DebugRouteHost['get']>[2],
  );

  // GET /debug/prompts/{session_id}/dispatch-log -------------------------
  const debugPromptDispatchLogRoute = defineRoute(
    {
      method: 'GET',
      path: '/debug/prompts/{session_id}/dispatch-log',
      params: sessionIdParamSchema,
    },
    async (req, reply) => {
      const { session_id: sid } = req.params;
      const prompts = ix.invokeFunction((a) => a.get(IPromptService)) as PromptService;
      const entries = prompts._dispatchLogForTest(sid) ?? [];
      reply.send(okEnvelope({ entries }, req.id));
    },
  );
  app.get(
    debugPromptDispatchLogRoute.path,
    debugPromptDispatchLogRoute.options,
    debugPromptDispatchLogRoute.handler as Parameters<DebugRouteHost['get']>[2],
  );
}
