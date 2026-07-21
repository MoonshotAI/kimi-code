/**
 * `GET /sessions/{session_id}/transcript` — turn-granular session transcript.
 *
 * The page unit is the turn: a page is a contiguous slice of turns plus the
 * markers/taskrefs in their segments (`paginateTurns`); `tasks`,
 * `interactions`, `attachments`, `todos`, `meta`, `agents` and
 * `pending_interactions` are global state and ship unpaginated with every
 * response.
 *
 *   - Live sessions answer from the in-memory `TranscriptStore`
 *     (`TranscriptService.forSessionLive`), awaiting the requested agent's
 *     wire-records backfill (`TranscriptService.whenReady` /
 *     `TranscriptService.ensureAgentHistory`) so first reads carry history —
 *     for any agent id, including unmaterialized subagents.
 *   - Cold sessions rebuild the requested agent from the persisted wire
 *     records (`TranscriptService.readColdSnapshot`, same reduction as the
 *     snapshot reader); an agent without records pages empty.
 *
 * **Error mapping**: unknown session → `40401` (session.not_found); invalid
 * query → `40001` (validation.failed, via defineRoute).
 *
 * `GET /sessions/{session_id}/transcript/ops` is the point-to-point catch-up
 * companion: journaled op batches with seq > `since_seq` for one agent (live
 * sessions only — cold sessions answer `complete: false`), letting a client
 * that holds watermark N converge without a full refresh.
 */

import { MAIN_AGENT_ID, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  isPlainAgentId,
  paginateTurns,
  transcriptOpsCatchupResponseSchema,
  transcriptResponseSchema,
} from '@moonshot-ai/transcript';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { defineRoute } from '../middleware/defineRoute';
import type { TranscriptService } from '../services/transcript/transcriptService';

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

/**
 * `GET .../transcript/ops` query: `since_seq` is the caller's op-batch
 * watermark (coerced from the query string, like `page_size` above).
 */
const transcriptOpsQueryCoercion = z
  .object({
    agent_id: z.string().min(1),
    since_seq: z.coerce.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

/** Default turns per page (protocol contract; max enforced by the query schema). */
const DEFAULT_PAGE_SIZE = 20;

export interface TranscriptRouteDeps {
  readonly core: Scope;
  readonly transcriptService: TranscriptService;
}

export function registerTranscriptRoutes(app: TranscriptRouteHost, deps: TranscriptRouteDeps): void {
  const { transcriptService } = deps;

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
        'Turn-granular session transcript page: live sessions read the in-memory store (wire-records backfill awaited per requested agent), cold sessions rebuild the requested agent from the persisted wire records',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;
      const pageQuery = {
        beforeTurn: query.before_turn,
        afterTurn: query.after_turn,
        pageSize: query.page_size ?? DEFAULT_PAGE_SIZE,
      };

      // Live session — answer from the bound store, after the requested
      // agent's history backfill has landed (full reads always see the
      // established transcript, for any agent id).
      const store = transcriptService.forSessionLive(session_id);
      if (store !== undefined) {
        await transcriptService.whenReady(session_id);
        await transcriptService.ensureAgentHistory(session_id, query.agent_id);
        const transcript = store.ensureAgent(query.agent_id);
        const page = paginateTurns(transcript.getItems(), pageQuery);
        reply.send(
          okEnvelope(
            {
              agent_id: query.agent_id,
              items: page.items,
              has_more: page.hasMore,
              tasks: [...transcript.getTasks().values()],
              interactions: [...transcript.getInteractions().values()],
              attachments: [...transcript.getAttachments().values()],
              todos: [...transcript.getTodos().values()],
              meta: transcript.getMeta(),
              agents: store.agents(),
              pending_interactions: transcript.listPendingInteractions(),
              // Watermark: this state includes every op batch with seq <= N.
              seq: transcriptService.getSeqWatermark(session_id, query.agent_id),
            },
            req.id,
          ),
        );
        return;
      }

      // Cold session — rebuild the requested agent from its wire records.
      const snapshot = await transcriptService.readColdSnapshot(session_id, query.agent_id);
      if (snapshot === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      const page = paginateTurns(snapshot.items, pageQuery);
      // The roster comes from the persisted session metadata — never from
      // the requested id itself: include it only when it actually has
      // content (or is main), so an empty probe conjures no ghost entry.
      const roster = (await transcriptService.readColdRoster(session_id)) ?? [];
      if (
        !roster.some((d) => d.agentId === query.agent_id) &&
        (snapshot.items.length > 0 || snapshot.tasks.length > 0 || query.agent_id === MAIN_AGENT_ID)
      ) {
        roster.push({
          agentId: query.agent_id,
          type: query.agent_id === MAIN_AGENT_ID ? ('main' as const) : ('sub' as const),
        });
      }
      reply.send(
        okEnvelope(
          {
            agent_id: query.agent_id,
            items: page.items,
            has_more: page.hasMore,
            tasks: snapshot.tasks,
            interactions: snapshot.interactions,
            attachments: snapshot.attachments,
            todos: snapshot.todos,
            meta: snapshot.meta,
            agents: roster,
            pending_interactions: [],
          },
          req.id,
        ),
      );
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<TranscriptRouteHost['get']>[2]);

  const opsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/ops',
      params: sessionIdParamSchema,
      querystring: transcriptOpsQueryCoercion,
      success: { data: transcriptOpsCatchupResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Point-to-point transcript catch-up: journaled op batches with seq > since_seq for one agent, oldest first. complete:false means the session is not live or the journal no longer reaches back to since_seq — the caller must fall back to a full transcript refresh',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const query = req.query;

      const catchup = transcriptService.getOpsSince(session_id, query.agent_id, query.since_seq);
      if (catchup === undefined) {
        // Not live in this process: a truly unknown session is a 40401 (same
        // mapping as the transcript route); a known-but-cold session has no
        // journal, so the catch-up is incomplete by definition.
        const roster = await transcriptService.readColdRoster(session_id);
        if (roster === undefined) {
          sendSessionNotFound(reply, req.id, session_id);
          return;
        }
        reply.send(
          okEnvelope(
            { agent_id: query.agent_id, batches: [], latest_seq: 0, complete: false },
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(
          {
            agent_id: query.agent_id,
            batches: catchup.batches,
            latest_seq: catchup.latestSeq,
            complete: catchup.complete,
          },
          req.id,
        ),
      );
    },
  );
  app.get(opsRoute.path, opsRoute.options, opsRoute.handler as Parameters<TranscriptRouteHost['get']>[2]);
}

function sendSessionNotFound(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  sessionId: string,
): void {
  reply.send(
    errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`, requestId),
  );
}
