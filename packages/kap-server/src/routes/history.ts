import { isPlainAgentId } from '@moonshot-ai/transcript';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { serverMessageSchema } from '../protocol/v2/messages/index';
import { defineRoute } from '../middleware/defineRoute';
import { buildColdHistory, type ColdWireRecord } from '../services/v2Projection/coldHistory';

export interface HistoryRouteSource {
  readColdWireRecords(sessionId: string, agentId?: string): Promise<ColdWireRecord[] | undefined>;
}

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
    agent_id: z.string().min(1).optional(),
    before_turn: z.string().min(1).optional(),
    after_step: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
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

export const historyResponseSchema = z.object({
  session_id: z.string(),
  items: z.array(serverMessageSchema),
  has_more: z.boolean(),
  in_flight: z
    .object({
      turn_id: z.string(),
      step_id: z.string().optional(),
    })
    .nullable(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export interface HistoryRouteDeps {
  readonly transcript: HistoryRouteSource;
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
        'Cold-rebuilt terminal-entity history page for a session agent: wire.jsonl records are folded into the same message shapes the WS stream emits, grouped turn → step with keyset paging (before_turn pages older, after_step catches the tail up) and an in_flight marker for the unfinished turn',
      tags: ['history'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;
      const agentId = query.agent_id ?? 'main';
      const records = await deps.transcript.readColdWireRecords(session_id, agentId);
      if (records === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id));
        return;
      }
      const page = buildColdHistory(session_id, agentId, records, {
        beforeTurn: query.before_turn,
        afterStep: query.after_step,
        pageSize: query.page_size,
      });
      reply.send(okEnvelope(page, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<HistoryRouteHost['get']>[2]);
}
