/**
 * `GET /sessions/{session_id}/snapshot` — IM-style initial sync.
 *
 * Assembles an atomic-at-a-watermark view for client rebuild:
 *
 *   as_of_seq / epoch    ← `IWSBroadcastService.getSnapshotState`
 *   session              ← `ISessionService.get`
 *   messages (asc)       ← `IMessageService.list` (most recent page)
 *   in_flight_turn       ← broadcast's `InFlightTurnTracker`
 *   pending_approvals    ← server `ApprovalService.listPending`
 *   pending_questions    ← server `QuestionService.listPending`
 *
 * Watermark stability: the durable seq is read before and after assembly;
 * if a durable event landed in between, assembly retries (bounded). Durable
 * events are low-frequency (turn/tool boundaries — deltas are volatile and
 * don't advance seq), so this converges almost immediately. After the
 * retries are exhausted the latest watermark is returned — the client's
 * seq-guard drops any overlap on replay.
 *
 * **Error mapping**: `SessionNotFoundError` → 40401; everything else falls
 * through to the global error handler (→ 50001).
 */

import {
  ErrorCode,
  sessionSnapshotResponseSchema,
  type Message,
  type Session,
} from '@moonshot-ai/protocol';
import { IApprovalService, IMessageService, IPromptService, IQuestionService, ISessionService, SessionNotFoundError, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { ApprovalService } from '#/services/approval/approvalService';
import type { QuestionService } from '#/services/question/questionService';
import { IWSBroadcastService } from '#/services/gateway';

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

/** Bounded watermark-stability retries (see module header). */
const MAX_ASSEMBLY_ATTEMPTS = 3;

export function registerSnapshotRoutes(
  app: SnapshotRouteHost,
  ix: IInstantiationService,
): void {
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
      try {
        const { session_id } = req.params;
        const data = await ix.invokeFunction(async (a) => {
          const broadcast = a.get(IWSBroadcastService);
          const sessionService = a.get(ISessionService);
          const messageService = a.get(IMessageService);
          const promptService = a.get(IPromptService);
          const approvals = a.get(IApprovalService) as ApprovalService;
          const questions = a.get(IQuestionService) as QuestionService;

          let snapState = await broadcast.getSnapshotState(session_id);
          let session: Session | undefined;
          let items: Message[] = [];
          let hasMore = false;

          for (let attempt = 0; attempt < MAX_ASSEMBLY_ATTEMPTS; attempt++) {
            session = await sessionService.get(session_id);
            const page = await messageService.list(session_id, {
              page_size: SNAPSHOT_MESSAGE_PAGE_SIZE,
            });
            // IMessageService returns newest-first; snapshot serves ascending.
            items = [...page.items].reverse();
            hasMore = page.has_more;

            const post = await broadcast.getSnapshotState(session_id);
            const stable = post.seq === snapState.seq && post.epoch === snapState.epoch;
            snapState = post;
            if (stable) break;
          }

          const currentPromptId = promptService.getCurrentPromptId(session_id);
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
            pending_approvals: approvals.listPending(session_id),
            pending_questions: questions.listPending(session_id),
          };
        });
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id));
          return;
        }
        throw err;
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}
