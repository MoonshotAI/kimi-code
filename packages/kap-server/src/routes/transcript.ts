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
 *
 * `GET /sessions/{session_id}/transcript/user-messages` projects every
 * turn-opening input (turns with a defined `prompt`) out of the transcript,
 * grouped per agent — agents are separate transcripts, so user messages are
 * per-agent by construction. It reads the same live-store / cold-rebuild
 * paths as the paged route, but unpaginated (user messages are few compared
 * to the timeline); `agent_id` is optional and narrows the read to one agent.
 */

import { MAIN_AGENT_ID, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  isPlainAgentId,
  paginateTurns,
  transcriptOpsCatchupResponseSchema,
  transcriptResponseSchema,
  transcriptUserMessagesResponseSchema,
  type TranscriptAttachment,
  type TranscriptItem,
  type TurnOrigin,
  type TurnState,
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

/**
 * `GET .../transcript/user-messages` query: `agent_id` is optional — present
 * reads that one agent, absent reads every rostered agent (agents are
 * separate transcripts, so user messages are per-agent by construction).
 */
const userMessagesQueryCoercion = z
  .object({
    agent_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.agent_id !== undefined && !isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

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

  const userMessagesRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/user-messages',
      params: sessionIdParamSchema,
      querystring: userMessagesQueryCoercion,
      success: { data: transcriptUserMessagesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'All turn-opening inputs ("user messages") of a session, grouped per agent: every turn with a defined prompt (real user text, user-slash skill/plugin commands, cron prompts — distinguish via origin). agent_id optional: present reads one agent, absent reads every rostered agent. Live sessions answer from the in-memory store (history backfill awaited per agent), cold sessions rebuild from the persisted wire records. Unpaginated; attachment entities referenced by the messages ride along (metadata only)',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const { agent_id } = req.query;

      // Live session — the store already holds the full timeline; the roster
      // was seeded from session metadata on bind, so an agent_id-less read
      // covers every agent (each backfilled on demand, like the paged route).
      const store = transcriptService.forSessionLive(session_id);
      if (store !== undefined) {
        await transcriptService.whenReady(session_id);
        const agentIds =
          agent_id !== undefined ? [agent_id] : store.agents().map((d) => d.agentId);
        const agents = [];
        for (const agentId of agentIds) {
          await transcriptService.ensureAgentHistory(session_id, agentId);
          const transcript = store.ensureAgent(agentId);
          const attachments = transcript.getAttachments();
          agents.push({
            agent_id: agentId,
            ...projectUserMessages(transcript.getItems(), (id) => attachments.get(id)),
          });
        }
        reply.send(okEnvelope({ agents }, req.id));
        return;
      }

      // Cold session — rebuild each agent from its wire records. The roster
      // comes from the persisted session metadata; main is always included on
      // a full read since it may have records even when the metadata lists no
      // agents (same fallback as the paged route's ghost-entry rule).
      const roster = await transcriptService.readColdRoster(session_id);
      if (roster === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      const agentIds = agent_id !== undefined ? [agent_id] : roster.map((d) => d.agentId);
      if (agent_id === undefined && !agentIds.includes(MAIN_AGENT_ID)) {
        agentIds.unshift(MAIN_AGENT_ID);
      }
      const agents = [];
      for (const agentId of agentIds) {
        const snapshot = await transcriptService.readColdSnapshot(session_id, agentId);
        if (snapshot === undefined) {
          sendSessionNotFound(reply, req.id, session_id);
          return;
        }
        const byId = new Map(snapshot.attachments.map((a) => [a.attachmentId, a]));
        agents.push({
          agent_id: agentId,
          ...projectUserMessages(snapshot.items, (id) => byId.get(id)),
        });
      }
      reply.send(okEnvelope({ agents }, req.id));
    },
  );
  app.get(
    userMessagesRoute.path,
    userMessagesRoute.options,
    userMessagesRoute.handler as Parameters<TranscriptRouteHost['get']>[2],
  );
}

/**
 * One user-message wire entry (snake_case projection of the turn header).
 */
interface UserMessageEntry {
  turn_id: string;
  ordinal: number;
  state: TurnState;
  origin: TurnOrigin;
  prompt: string;
  attachment_ids?: readonly string[];
  started_at?: string;
}

/**
 * Project the user messages out of one agent's full timeline: every turn with
 * a defined prompt, in timeline order. `resolveAttachment` looks up the
 * referenced entities (live: the store's attachment map; cold: the snapshot's
 * array) so the response carries their metadata alongside the ids.
 */
function projectUserMessages(
  items: readonly TranscriptItem[],
  resolveAttachment: (id: string) => TranscriptAttachment | undefined,
): { messages: UserMessageEntry[]; attachments: TranscriptAttachment[] } {
  const messages: UserMessageEntry[] = [];
  const attachments = new Map<string, TranscriptAttachment>();
  for (const item of items) {
    if (item.kind !== 'turn' || item.prompt === undefined) continue;
    messages.push({
      turn_id: item.turnId,
      ordinal: item.ordinal,
      state: item.state,
      origin: item.origin,
      prompt: item.prompt,
      attachment_ids: item.attachmentIds,
      started_at: item.startedAt,
    });
    for (const id of item.attachmentIds ?? []) {
      const attachment = resolveAttachment(id);
      if (attachment !== undefined) attachments.set(id, attachment);
    }
  }
  return { messages, attachments: [...attachments.values()] };
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
