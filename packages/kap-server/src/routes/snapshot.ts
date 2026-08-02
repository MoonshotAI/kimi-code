/**
 * `GET /sessions/{session_id}/snapshot` — IM-style initial sync.
 *
 * Engine mode (the only mode): the handler projects a minimal snapshot from
 * the Rust-engine session (`rustSession`) — state + accumulated messages.
 * The retired v2 journal / snapshot-reader chain was deleted with the engine
 * migration.
 *
 * **Error mapping**: unknown engine session → 40401; anything else falls
 * through to the global error handler (→ 50001).
 */

import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
} from '../protocol/rest-snapshot';
import { emptySessionUsage } from '../protocol/session';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { RustSessionService } from '../services/rustSession/rustSessionService';

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

interface SnapshotRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: { session_id: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SnapshotRouteDeps {
  /** Rust engine session backend (the only engine). */
  readonly rustSession: RustSessionService;
}

export function registerSnapshotRoutes(app: SnapshotRouteHost, deps: SnapshotRouteDeps): void {
  const { rustSession } = deps;

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/snapshot',
      params: sessionIdParamSchema,
      success: { data: sessionSnapshotResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description:
        'Atomic session snapshot for client rebuild: state + as_of_seq watermark + epoch',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      // Project a minimal snapshot from the engine session — state +
      // accumulated messages; no v2 journal/snapshot reader.
      const session = rustSession.getSession(session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id),
        );
        return;
      }
      const messages = rustSession.getMessages(session_id).map((m) => ({
        id: m.id,
        session_id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
      }));
      reply.send(
        okEnvelope(
          {
            as_of_seq: 0,
            epoch: 'rust',
            session: {
              id: session.id,
              // v1 workspace ids are `wd_<slug>_<hash12>`; the engine session
              // has no workspace registry entry, so synthesize a stable id
              // from the session id hash.
              workspace_id: `wd_engine_${hash12(session.id)}`,
              title: session.title,
              created_at: session.createdAt,
              updated_at: session.updatedAt,
              busy: session.busy,
              main_turn_active: session.busy,
              pending_interaction: 'none',
              last_turn_reason: session.lastTurnReason ?? 'completed',
              archived: false,
              metadata: { cwd: session.workDir },
              agent_config: { model: '' },
              usage: emptySessionUsage(),
              permission_rules: [],
              message_count: messages.length,
              last_seq: 0,
            },
            messages: { items: messages, has_more: false },
            in_flight_turn: null,
            // Engine-only projection: approvals/questions surface via the WS
            // event stream (broadcastRustFrame), not the snapshot journal —
            // always empty here. The v2 journal / snapshot-reader chain was
            // deleted with the engine migration.
            pending_approvals: [],
            pending_questions: [],
          },
          req.id,
        ),
      );
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

/** Deterministic 12-hex suffix for the synthesized engine workspace id. */
function hash12(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + (input.codePointAt(i) ?? 0)) >>> 0;
  }
  return hash.toString(16).padStart(12, '0').slice(0, 12);
}
