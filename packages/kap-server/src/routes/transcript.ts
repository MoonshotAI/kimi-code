import { MAIN_AGENT_ID, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  isPlainAgentId,
  paginateTurns,
  transcriptOpsCatchupResponseSchema,
  transcriptPlanResponseSchema,
  transcriptResponseSchema,
  transcriptUserMessagesResponseSchema,
  type ToolCallFrame,
  type TranscriptAttachment,
  type TranscriptInteraction,
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

const DEFAULT_PAGE_SIZE = 20;

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

const planQueryCoercion = z
  .object({
    agent_id: z.string().min(1),
    tool_call_id: z.string().min(1).optional(),
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
              seq: transcriptService.getSeqWatermark(session_id, query.agent_id),
            },
            req.id,
          ),
        );
        return;
      }

      const snapshot = await transcriptService.readColdSnapshot(session_id, query.agent_id);
      if (snapshot === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      const page = paginateTurns(snapshot.items, pageQuery);
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
        'All turn-opening inputs ("user messages") of a session, grouped per agent: every turn with a defined prompt (real user text, user-slash skill/plugin commands, cron prompts — distinguish via origin), plus attachment-only prompts projected with an empty prompt string. agent_id optional: present reads one agent, absent reads every rostered agent. Live sessions answer from the in-memory store (history backfill awaited per agent), cold sessions rebuild from the persisted wire records. Unpaginated; attachment entities referenced by the messages ride along (metadata only)',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const { agent_id } = req.query;

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

  const planRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/transcript/plan',
      params: sessionIdParamSchema,
      querystring: planQueryCoercion,
      success: { data: transcriptPlanResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TOOL_CALL_NOT_FOUND]: {},
      },
      description:
        'Plan information of an agent\'s ExitPlanMode tool calls: the reviewed plan content, plan file path, offered options, and the review outcome, in timeline order. agent_id required; tool_call_id optional — present narrows the read to that one call (unknown id or non-ExitPlanMode call → 40416), absent lists every call with recoverable plan content. Content is projected from the linked approval interaction (interactive reviews, live or cold), the live tool frame display (auto mode), or the tool result output text (cold rebuilds without an interaction). Live sessions read the in-memory store (history backfill awaited), cold sessions rebuild the agent from the persisted wire records',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const { agent_id, tool_call_id } = req.query;

      const store = transcriptService.forSessionLive(session_id);
      if (store !== undefined) {
        await transcriptService.whenReady(session_id);
        await transcriptService.ensureAgentHistory(session_id, agent_id);
        const transcript = store.ensureAgent(agent_id);
        const plans = projectPlans(
          transcript.getItems(),
          [...transcript.getInteractions().values()],
          tool_call_id,
        );
        if (tool_call_id !== undefined && plans.length === 0) {
          sendToolCallNotFound(reply, req.id, tool_call_id);
          return;
        }
        reply.send(okEnvelope({ agent_id, plans }, req.id));
        return;
      }

      const snapshot = await transcriptService.readColdSnapshot(session_id, agent_id);
      if (snapshot === undefined) {
        sendSessionNotFound(reply, req.id, session_id);
        return;
      }
      const plans = projectPlans(snapshot.items, snapshot.interactions, tool_call_id);
      if (tool_call_id !== undefined && plans.length === 0) {
        sendToolCallNotFound(reply, req.id, tool_call_id);
        return;
      }
      reply.send(okEnvelope({ agent_id, plans }, req.id));
    },
  );
  app.get(planRoute.path, planRoute.options, planRoute.handler as Parameters<TranscriptRouteHost['get']>[2]);
}

interface UserMessageEntry {
  turn_id: string;
  ordinal: number;
  state: TurnState;
  origin: TurnOrigin;
  prompt: string;
  attachment_ids?: readonly string[];
  started_at?: string;
}

function projectUserMessages(
  items: readonly TranscriptItem[],
  resolveAttachment: (id: string) => TranscriptAttachment | undefined,
): { messages: UserMessageEntry[]; attachments: TranscriptAttachment[] } {
  const messages: UserMessageEntry[] = [];
  const attachments = new Map<string, TranscriptAttachment>();
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    const hasAttachments = item.attachmentIds !== undefined && item.attachmentIds.length > 0;
    if (item.prompt === undefined && !hasAttachments) continue;
    messages.push({
      turn_id: item.turnId,
      ordinal: item.ordinal,
      state: item.state,
      origin: item.origin,
      prompt: item.prompt ?? '',
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

function sendToolCallNotFound(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  toolCallId: string,
): void {
  reply.send(
    errEnvelope(
      ErrorCode.TOOL_CALL_NOT_FOUND,
      `no ExitPlanMode tool call found for tool_call_id: ${toolCallId}`,
      requestId,
    ),
  );
}

interface PlanReviewInfo {
  state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  selected_option?: string;
  feedback?: string;
}

interface PlanInfo {
  tool_call_id: string;
  turn_id: string;
  source: 'interaction' | 'display' | 'output';
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
  review?: PlanReviewInfo;
}

interface PlanReviewDisplayInfo {
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
}

function projectPlans(
  items: readonly TranscriptItem[],
  interactions: readonly TranscriptInteraction[],
  toolCallId?: string,
): PlanInfo[] {
  const plans: PlanInfo[] = [];
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool' || frame.name !== 'ExitPlanMode') continue;
        if (toolCallId !== undefined && frame.toolCallId !== toolCallId) continue;
        const info = projectPlanFrame(item.turnId, frame, interactions);
        if (info !== undefined) plans.push(info);
      }
    }
  }
  return plans;
}

function projectPlanFrame(
  turnId: string,
  frame: ToolCallFrame,
  interactions: readonly TranscriptInteraction[],
): PlanInfo | undefined {
  const toolCallId = frame.toolCallId;
  const interaction = interactions.find(
    (i) => i.interactionKind === 'approval' && i.toolCallId === toolCallId,
  );
  const review = readPlanReview(interaction);

  const requestDisplay =
    interaction !== undefined && interaction.request !== null && typeof interaction.request === 'object'
      ? (interaction.request as { display?: unknown }).display
      : undefined;
  const fromInteraction = readPlanReviewDisplay(requestDisplay);
  if (fromInteraction !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'interaction', ...fromInteraction, review };
  }
  const fromDisplay = readPlanReviewDisplay(frame.display);
  if (fromDisplay !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'display', ...fromDisplay, review };
  }
  const fromOutput = parsePlanFromOutput(frame.output);
  if (fromOutput !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'output', ...fromOutput, review };
  }
  return undefined;
}

function readPlanReview(interaction: TranscriptInteraction | undefined): PlanReviewInfo | undefined {
  if (interaction === undefined) return undefined;
  const state = interaction.state;
  if (state !== 'pending' && state !== 'approved' && state !== 'rejected' && state !== 'cancelled') {
    return undefined;
  }
  const response =
    interaction.response !== null && typeof interaction.response === 'object'
      ? (interaction.response as { selectedLabel?: unknown; feedback?: unknown })
      : undefined;
  const selected =
    typeof response?.selectedLabel === 'string' && response.selectedLabel.length > 0
      ? response.selectedLabel
      : undefined;
  const feedback =
    typeof response?.feedback === 'string' && response.feedback.length > 0
      ? response.feedback
      : undefined;
  return { state, selected_option: selected, feedback };
}

function readPlanReviewDisplay(display: unknown): PlanReviewDisplayInfo | undefined {
  if (display === null || typeof display !== 'object') return undefined;
  const d = display as { kind?: unknown; plan?: unknown; path?: unknown; options?: unknown };
  if (d.kind !== 'plan_review' || typeof d.plan !== 'string' || d.plan.trim().length === 0) {
    return undefined;
  }
  const options = Array.isArray(d.options)
    ? d.options
        .map((option: unknown): { label: string; description?: string } | null => {
          if (option === null || typeof option !== 'object') return null;
          const o = option as { label?: unknown; description?: unknown };
          if (typeof o.label !== 'string' || o.label.length === 0) return null;
          return {
            label: o.label,
            description: typeof o.description === 'string' ? o.description : undefined,
          };
        })
        .filter((o): o is { label: string; description?: string } => o !== null)
    : undefined;
  return {
    plan: d.plan,
    path: typeof d.path === 'string' ? d.path : undefined,
    options: options !== undefined && options.length > 0 ? options : undefined,
  };
}

const PLAN_SAVED_TO_MARKER = 'Plan saved to: ';
const PLAN_BODY_MARKERS = ['## Approved Plan:\n', '## Plan (auto-approved, not user-reviewed):\n'];

function parsePlanFromOutput(output: unknown): { plan: string; path?: string } | undefined {
  if (typeof output !== 'string') return undefined;
  let path: string | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith(PLAN_SAVED_TO_MARKER)) {
      path = line.slice(PLAN_SAVED_TO_MARKER.length).trim() || undefined;
      break;
    }
  }
  for (const marker of PLAN_BODY_MARKERS) {
    const index = output.indexOf(marker);
    if (index === -1) continue;
    const plan = output.slice(index + marker.length);
    if (plan.trim().length > 0) return { plan, path };
  }
  return undefined;
}
