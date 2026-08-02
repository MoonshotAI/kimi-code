/**
 * `GET /sessions/{session_id}/transcript` — turn-granular session transcript.
 *
 * Engine mode (the only mode): the transcript is rebuilt from the accumulated
 * Rust-engine messages (`rustSession.getMessages`) as a simplified
 * turn-granular view — no v2 `TranscriptStore`. The v2-backed companion
 * routes (`/transcript/ops`, `/transcript/user-messages`, `/transcript/plan`)
 * were retired with the engine migration.
 *
 * **Error mapping**: unknown engine session → `40401`; invalid query →
 * `40001` (validation.failed, via defineRoute).
 */

import { isPlainAgentId, transcriptResponseSchema } from '@moonshot-ai/transcript';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { defineRoute } from '../middleware/defineRoute';
import type { RustSessionService, RustWireMessage } from '../services/rustSession/rustSessionService';

interface TranscriptRouteHost {
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

/**
 * HTTP query strings arrive as `Record<string, string>`; `page_size` is
 * coerced here so the protocol's response schema stays HTTP-agnostic —
 * mirrors `messages.ts:messagesListQueryCoercion`.
 */
const transcriptQueryCoercion = z
  .object({
    agent_id: z.string().min(1),
    before_turn: z.string().min(1).optional(),
    after_turn: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_turn !== undefined && value.after_turn !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_turn and after_turn are mutually exclusive',
        path: ['before_turn'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export interface TranscriptRouteDeps {
  /** Rust engine session backend (the only engine). */
  readonly rustSession: RustSessionService;
}

export function registerTranscriptRoutes(app: TranscriptRouteHost, deps: TranscriptRouteDeps): void {
  const { rustSession } = deps;

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript',
      params: sessionIdParamSchema,
      querystring: transcriptQueryCoercion,
      success: { data: transcriptResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Turn-granular session transcript page, rebuilt from the engine messages',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      // Engine mode: rebuild a simplified turn-granular transcript from the
      // accumulated engine messages — no v2 store.
      if (rustSession.getSession(session_id) === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id),
        );
        return;
      }
      const messages = rustSession.getMessages(session_id);
      const items = buildRustTranscriptItems(messages);
      reply.send(
        okEnvelope(
          {
            agent_id: 'main',
            items,
            has_more: false,
            tasks: [],
            interactions: [],
            attachments: [],
            todos: [],
            meta: {},
            agents: [],
            pending_interactions: [],
            seq: 0,
          },
          req.id,
        ),
      );
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<TranscriptRouteHost['get']>[2]);
}

function buildRustTranscriptItems(messages: RustWireMessage[]): unknown[] {
  const items: unknown[] = [];
  let current: {
    kind: string;
    turnId: string;
    ordinal: number;
    state: string;
    origin: string;
    prompt?: string;
    steps: Array<{
      kind: string;
      stepId: string;
      turnId: string;
      ordinal: number;
      state: string;
      frames: unknown[];
    }>;
    startedAt?: string;
    endedAt?: string;
  } | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current !== null) {
        current.endedAt = msg.created_at;
        items.push(current);
      }
      current = {
        kind: 'turn',
        turnId: `turn-${items.length + 1}`,
        ordinal: items.length + 1,
        state: 'completed',
        origin: 'user',
        prompt: textOf(msg),
        steps: [],
        startedAt: msg.created_at,
      };
      continue;
    }
    if (current === null) continue;
    if (current.steps.length === 0) {
      current.steps.push({
        kind: 'step',
        stepId: `step-${current.ordinal}`,
        turnId: current.turnId,
        ordinal: 1,
        state: 'completed',
        frames: [],
      });
    }
    const step = current.steps[0]!;
    if (msg.role === 'assistant') {
      const text = textOf(msg);
      if (text.length > 0) {
        step.frames.push({
          kind: 'text',
          frameId: `frame-${step.frames.length + 1}`,
          role: 'assistant',
          text,
        });
      }
    } else if (msg.role === 'tool') {
      const use = msg.content[0];
      const result = msg.content[1];
      step.frames.push({
        kind: 'tool',
        frameId: `frame-${step.frames.length + 1}`,
        toolCallId: use?.tool_call_id ?? '',
        name: use?.tool_name ?? '',
        state: 'completed',
        ...(use?.input !== undefined ? { input: use.input } : {}),
        ...(result?.content !== undefined ? { output: result.content } : {}),
      });
    }
  }
  if (current !== null) {
    current.endedAt = current.startedAt;
    items.push(current);
  }
  return items;
}

function textOf(msg: RustWireMessage): string {
  const part = msg.content.find((c) => c.type === 'text');
  return part?.text ?? '';
}
