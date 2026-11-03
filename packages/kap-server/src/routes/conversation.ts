import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  agentPlansSchema,
  conversationTurnsPageSchema,
  type ConversationTurn,
  type PlanEntry,
  type ToolCallItem,
} from '../protocol/conversation';
import { ErrorCode } from '../protocol/error-codes';
import { interactionOutcome } from '../protocol/interaction-wire';
import type { ConversationService } from '../services/conversation/conversationService';

interface ConversationRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const agentParamsSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1).regex(/^[^/\\]+$/),
});

const turnsQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const plansQuerySchema = z.object({
  tool_call_id: z.string().min(1).optional(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const DEFAULT_PAGE_TURNS = 20;

export function registerConversationRoutes(
  app: ConversationRouteHost,
  conversations: ConversationService,
): void {
  const turnsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/agents/{agent_id}/turns',
      params: agentParamsSchema,
      querystring: turnsQuerySchema,
      success: { data: conversationTurnsPageSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description:
        'One page of an agent\'s turns, oldest first: the latest page, or the turns whose ordinal is below before',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id, agent_id } = req.params;
      const feed = await conversations.feed(session_id, agent_id);
      if (feed === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session not found: ${session_id}`, req.id));
        return;
      }
      const page = feed.snapshot(req.query.before, req.query.limit ?? DEFAULT_PAGE_TURNS);
      reply.send(okEnvelope({ agent_id, turns: await feed.hydrate(page.turns), has_more: page.has_more }, req.id));
    },
  );
  app.get(turnsRoute.path, turnsRoute.options, turnsRoute.handler as Parameters<ConversationRouteHost['get']>[2]);

  const plansRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/agents/{agent_id}/plans',
      params: agentParamsSchema,
      querystring: plansQuerySchema,
      success: { data: agentPlansSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TOOL_CALL_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description:
        'Plans of an agent\'s ExitPlanMode tool calls in timeline order: the reviewed plan, plan file path, offered options and review outcome. tool_call_id narrows the read to one call (an unknown id or a non-ExitPlanMode call is 40416)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id, agent_id } = req.params;
      const { tool_call_id } = req.query;
      const feed = await conversations.feed(session_id, agent_id);
      if (feed === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session not found: ${session_id}`, req.id));
        return;
      }
      const plans = projectPlans(feed.turns(), tool_call_id);
      if (tool_call_id !== undefined && plans.length === 0) {
        reply.send(
          errEnvelope(
            ErrorCode.TOOL_CALL_NOT_FOUND,
            `no ExitPlanMode tool call found for tool_call_id: ${tool_call_id}`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope({ agent_id, plans }, req.id));
    },
  );
  app.get(plansRoute.path, plansRoute.options, plansRoute.handler as Parameters<ConversationRouteHost['get']>[2]);
}

function projectPlans(turns: readonly ConversationTurn[], toolCallId: string | undefined): PlanEntry[] {
  const plans: PlanEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'tool_call' || item.name !== 'ExitPlanMode') continue;
      if (toolCallId !== undefined && item.item_id !== toolCallId) continue;
      const plan = projectPlan(turn.turn_id, item);
      if (plan !== undefined) plans.push(plan);
    }
  }
  return plans;
}

function projectPlan(turnId: string, item: ToolCallItem): PlanEntry | undefined {
  const base = { tool_call_id: item.item_id, turn_id: turnId, review: planReview(item) };
  const requestDisplay = (item.interaction?.request as { display?: unknown } | undefined)?.display;
  const fromInteraction = planReviewDisplay(requestDisplay);
  if (fromInteraction !== undefined) return { ...base, source: 'interaction', ...fromInteraction };
  const fromDisplay = planReviewDisplay(item.display);
  if (fromDisplay !== undefined) return { ...base, source: 'display', ...fromDisplay };
  const fromOutput = planFromOutput(item.output);
  if (fromOutput !== undefined) return { ...base, source: 'output', ...fromOutput };
  return undefined;
}

function planReview(item: ToolCallItem): PlanEntry['review'] {
  const interaction = item.interaction;
  if (interaction === undefined || interaction.kind !== 'approval') return undefined;
  if (interaction.status === 'pending') return { state: 'pending' };
  const outcome = interactionOutcome('approval', interaction.response);
  const response = (interaction.response ?? {}) as { selectedLabel?: unknown; feedback?: unknown };
  return {
    state: outcome === 'approved' || outcome === 'rejected' ? outcome : 'cancelled',
    selected_option: nonEmpty(response.selectedLabel),
    feedback: nonEmpty(response.feedback),
  };
}

function planReviewDisplay(
  display: unknown,
): Pick<PlanEntry, 'plan' | 'path' | 'options'> | undefined {
  if (display === null || typeof display !== 'object') return undefined;
  const d = display as { kind?: unknown; plan?: unknown; path?: unknown; options?: unknown };
  if (d.kind !== 'plan_review' || typeof d.plan !== 'string' || d.plan.trim().length === 0) return undefined;
  const options = Array.isArray(d.options)
    ? d.options.flatMap((option: unknown) => {
        if (option === null || typeof option !== 'object') return [];
        const o = option as { label?: unknown; description?: unknown };
        const label = nonEmpty(o.label);
        return label === undefined ? [] : [{ label, description: typeof o.description === 'string' ? o.description : undefined }];
      })
    : [];
  return {
    plan: d.plan,
    path: typeof d.path === 'string' ? d.path : undefined,
    options: options.length > 0 ? options : undefined,
  };
}

const PLAN_SAVED_TO_MARKER = 'Plan saved to: ';
const PLAN_BODY_MARKERS = ['## Approved Plan:\n', '## Plan (auto-approved, not user-reviewed):\n'];

function planFromOutput(output: unknown): Pick<PlanEntry, 'plan' | 'path'> | undefined {
  if (typeof output !== 'string') return undefined;
  const pathLine = output.split('\n').find((line) => line.startsWith(PLAN_SAVED_TO_MARKER));
  const path = pathLine === undefined ? undefined : nonEmpty(pathLine.slice(PLAN_SAVED_TO_MARKER.length).trim());
  for (const marker of PLAN_BODY_MARKERS) {
    const index = output.indexOf(marker);
    if (index === -1) continue;
    const plan = output.slice(index + marker.length);
    if (plan.trim().length > 0) return { plan, path };
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
