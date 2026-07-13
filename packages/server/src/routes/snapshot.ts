/**
 * `GET /sessions/{session_id}/snapshot` — IM-style initial sync.
 *
 * **Reader strategy** (controlled by `KIMI_SNAPSHOT_READER`):
 *
 *   - `auto` (default) — delegate to `ISnapshotService`, which reads
 *     `state.json` + `wire.jsonl` directly from disk and bypasses the heavy
 *     `core.rpc.listSessions`/`resumeSession`/`getContext` chain. Sub-200ms
 *     warm / sub-1s cold; legacy path was 5s+ p99 under load.
 *   - `legacy` — fall back to the old `ISessionService.get` + `IMessageService.list`
 *     assembly with the 3-attempt watermark-stability retry. Pure operator
 *     escape hatch; no silent per-request fallback.
 *
 * **Timeout**: the new path races against a hard `KIMI_SNAPSHOT_TIMEOUT_MS`
 * ceiling (default 4000ms, well under traefik's 5s cut-off). Timeout returns
 * 50001 with a structured log line so the gateway never sees a 499.
 *
 * **Error mapping**: `SnapshotNotFoundError` / `SessionNotFoundError` → 40401;
 * `SnapshotTimeoutError` → 50001 (`snapshot.timeout`); everything else falls
 * through to the global error handler (→ 50001).
 */

import {
  ErrorCode,
  sessionSnapshotResponseSchema,
  type Message,
  type Session,
} from '@moonshot-ai/protocol';
import { IApprovalService, IMessageService, IPromptService, IQuestionService, ISessionService, ILogService, SessionNotFoundError, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { ApprovalService } from '#/services/approval/approvalService';
import type { QuestionService } from '#/services/question/questionService';
import { IWSBroadcastService } from '#/services/gateway';
import {
  ISnapshotService,
  SnapshotNotFoundError,
  SnapshotTimeoutError,
  loadSnapshotConfig,
} from '#/services/snapshot';

interface SnapshotRouteHost {
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

/** Messages included in the snapshot page (most recent, ascending order). */
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

/** Bounded watermark-stability retries for the legacy fallback. */
const MAX_ASSEMBLY_ATTEMPTS = 3;

export function registerSnapshotRoutes(
  app: SnapshotRouteHost,
  ix: IInstantiationService,
): void {
  const config = loadSnapshotConfig();
  const useReader = config.mode !== 'legacy';

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/snapshot',
      params: sessionIdParamSchema,
      success: { data: sessionSnapshotResponseSchema },
      description:
        'Atomic session snapshot for client rebuild: state + as_of_seq watermark + epoch',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      try {
        const data = useReader
          ? await readViaSnapshotService(ix, session_id, config.timeoutMs)
          : await readViaLegacyAssembly(ix, session_id);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        if (err instanceof SnapshotNotFoundError || err instanceof SessionNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id));
          return;
        }
        if (err instanceof SnapshotTimeoutError) {
          ix.invokeFunction((a) => {
            a.get(ILogService).warn(
              { sid: session_id, duration_ms: err.timeoutMs },
              'snapshot.timeout',
            );
          });
          reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, err.message, req.id));
          return;
        }
        throw err;
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

async function readViaSnapshotService(
  ix: IInstantiationService,
  sid: string,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SnapshotTimeoutError(sid, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      ix.invokeFunction((a) => a.get(ISnapshotService).read(sid)),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readViaLegacyAssembly(ix: IInstantiationService, sid: string) {
  return ix.invokeFunction(async (a) => {
    const broadcast = a.get(IWSBroadcastService);
    const sessionService = a.get(ISessionService);
    const messageService = a.get(IMessageService);
    const promptService = a.get(IPromptService);
    const approvals = a.get(IApprovalService) as ApprovalService;
    const questions = a.get(IQuestionService) as QuestionService;

    let snapState = await broadcast.getSnapshotState(sid);
    let session: Session | undefined;
    let items: Message[] = [];
    let hasMore = false;

    for (let attempt = 0; attempt < MAX_ASSEMBLY_ATTEMPTS; attempt++) {
      session = await sessionService.get(sid);
      const page = await messageService.list(sid, {
        page_size: SNAPSHOT_MESSAGE_PAGE_SIZE,
      });
      items = [...page.items].reverse();
      hasMore = page.has_more;

      const post = await broadcast.getSnapshotState(sid);
      const stable = post.seq === snapState.seq && post.epoch === snapState.epoch;
      snapState = post;
      if (stable) break;
    }

    const currentPromptId = promptService.getCurrentPromptId(sid);
    const inFlightTurn = snapState.inFlightTurn;
    if (inFlightTurn !== null && currentPromptId !== undefined) {
      inFlightTurn.current_prompt_id = currentPromptId;
    }

    return {
      as_of_seq: snapState.seq,
      epoch: snapState.epoch,
      session: session!,
      messages: { items, has_more: hasMore },
      in_flight_turn: inFlightTurn,
      subagents: snapState.subagents,
      pending_approvals: approvals.listPending(sid),
      pending_questions: questions.listPending(sid),
    };
  });
}
