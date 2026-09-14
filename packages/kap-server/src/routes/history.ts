import { type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { historyResponseSchema } from '../protocol/messages';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import {
  HistorySessionNotFoundError,
  readSessionHistory,
  type HistoryServiceDeps,
} from '../services/history/historyService';

interface HistoryRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const historyQueryCoercion = z
  .object({
    before_turn: z.string().min(1).optional(),
    after_step: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(500).optional(),
    agent_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_turn !== undefined && value.after_step !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_turn and after_step are mutually exclusive',
        path: ['before_turn'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.agent_id !== undefined && !isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const AGENT_ID_PATTERN = /^[^/\\]+$/;

function isPlainAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId) && agentId !== '.' && agentId !== '..';
}

export interface HistoryRouteDeps {
  readonly core: Scope;
  readonly homeDir: string;
  readonly projection: HistoryServiceDeps['projection'];
}

export function registerHistoryRoutes(app: HistoryRouteHost, deps: HistoryRouteDeps): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/history',
      params: sessionIdParamSchema,
      querystring: historyQueryCoercion,
      success: { data: historyResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Flat entity-message history of one agent timeline, cold-rebuilt from the persisted wire records (live sessions flush first). Messages are time-ordered and share the WS entity schemas. before_turn pages to older turns, after_step catches up newer than a step, page_size bounds the page (default 200, max 500). agent_id defaults to the main agent. Live sessions carry in_flight with the current streaming position',
      tags: ['history'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const page = await readSessionHistory(deps, session_id, req.query);
        reply.send(okEnvelope(page, req.id));
      } catch (error) {
        if (error instanceof HistorySessionNotFoundError) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, req.id, error.stack),
          );
          return;
        }
        requestLog(req)?.error({ err: error }, 'history request failed');
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
            req.id,
            error instanceof Error ? error.stack : undefined,
          ),
        );
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<HistoryRouteHost['get']>[2]);
}
