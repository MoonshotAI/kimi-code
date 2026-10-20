import { useApp } from '@moonshot-ai/agent-core/app/index';
import { useInject } from '@moonshot-ai/agent-core/kernel/index';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import {
  InteractionRef,
  INTERACTION_TAG_SESSION_ID,
  type Interaction,
} from '#/features/interaction/index';

import { sessionFacade, unitsReady, useHttpRoute, useRootUnit } from '../scope';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';
import { groupHistoryIntoSnapshot, paginateTurns } from '../ws-v1/transcript';
import { WsV1BroadcasterRef } from '../ws-v1/sessionState';
import type {
  AgentTranscriptSnapshot,
  TranscriptInteraction,
  TranscriptItem,
  ToolCallFrame,
} from '../ws-v1/transcriptModel';

const DEFAULT_PAGE_SIZE = 20;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

interface AgentDescriptorView {
  readonly agentId: string;
  readonly type?: 'main' | 'sub' | 'independent';
}

const EMPTY_SNAPSHOT: AgentTranscriptSnapshot = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
};

export function useTranscriptRoutes(prefix: string): void {
  const app = useApp();
  const root = useRootUnit();
  const broadcaster = useInject(WsV1BroadcasterRef);

  const snapshotOf = async (
    session: Session,
    agentId: string,
  ): Promise<{ snapshot: AgentTranscriptSnapshot; watermark?: number }> => {
    const stream = broadcaster.value?.transcriptStreamState(session.id, agentId);
    if (stream !== undefined) {
      return { snapshot: stream.snapshot(), watermark: stream.watermark };
    }
    const agent = session.agents.get(agentId);
    if (agent === undefined) {
      return { snapshot: EMPTY_SNAPSHOT };
    }
    await agent.flush();
    return { snapshot: groupHistoryIntoSnapshot(agent.view.getState().messages) };
  };

  useHttpRoute({
    id: 'sessions.transcript',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/transcript`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const query = readTranscriptQuery(request.query);
      if ('error' in query) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, query.error);
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
        return;
      }
      await unitsReady(root);
      const agentId = query.agentId;
      const { snapshot, watermark } = await snapshotOf(session, agentId);
      const page = paginateTurns(snapshot.items, {
        beforeTurn: query.beforeTurn,
        afterTurn: query.afterTurn,
        pageSize: query.pageSize,
      });
      sendOk(request, response, {
        agent_id: agentId,
        items: page.items,
        has_more: page.hasMore,
        tasks: snapshot.tasks,
        interactions: interactionRecordsOf(root, session, snapshot),
        attachments: snapshot.attachments,
        todos: snapshot.todos,
        prompts: snapshot.prompts,
        meta: snapshot.meta,
        agents: rosterOf(session, agentId, snapshot),
        pending_interactions: pendingInteractionIds(root, session),
        ...(watermark !== undefined ? { seq: watermark } : {}),
      });
    },
  });

  useHttpRoute({
    id: 'sessions.transcriptPlan',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/transcript/plan`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const query = readPlanQuery(request.query);
      if ('error' in query) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, query.error);
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
        return;
      }
      await unitsReady(root);
      const agentId = query.agentId;
      const { snapshot } = await snapshotOf(session, agentId);
      const plans = projectPlans(
        snapshot.items,
        interactionRecordsOf(root, session, snapshot),
        query.toolCallId,
      );
      if (query.toolCallId !== undefined && plans.length === 0) {
        sendErr(
          request,
          response,
          ErrorCode.TOOL_CALL_NOT_FOUND,
          `no ExitPlanMode tool call found for tool_call_id: ${query.toolCallId}`,
        );
        return;
      }
      sendOk(request, response, { agent_id: agentId, plans });
    },
  });
}

function isPlainAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

function readTranscriptQuery(
  raw: unknown,
):
  | { agentId: string; beforeTurn?: string; afterTurn?: string; pageSize: number }
  | { readonly error: string } {
  const query = (raw ?? {}) as Record<string, unknown>;
  const agentId = query['agent_id'];
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return { error: 'agent_id is required' };
  }
  if (!isPlainAgentId(agentId)) {
    return { error: 'agent_id must be a plain agent id (no path separators)' };
  }
  const beforeTurn = query['before_turn'];
  const afterTurn = query['after_turn'];
  if (beforeTurn !== undefined && (typeof beforeTurn !== 'string' || beforeTurn.length === 0)) {
    return { error: 'before_turn must be a non-empty string' };
  }
  if (afterTurn !== undefined && (typeof afterTurn !== 'string' || afterTurn.length === 0)) {
    return { error: 'after_turn must be a non-empty string' };
  }
  if (beforeTurn !== undefined && afterTurn !== undefined) {
    return { error: 'before_turn and after_turn are mutually exclusive' };
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (query['page_size'] !== undefined) {
    const parsed = Number(query['page_size']);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return { error: 'page_size must be an integer between 1 and 100' };
    }
    pageSize = parsed;
  }
  return {
    agentId,
    beforeTurn: beforeTurn as string | undefined,
    afterTurn: afterTurn as string | undefined,
    pageSize,
  };
}

function readPlanQuery(
  raw: unknown,
): { agentId: string; toolCallId?: string } | { readonly error: string } {
  const query = (raw ?? {}) as Record<string, unknown>;
  const agentId = query['agent_id'];
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return { error: 'agent_id is required' };
  }
  if (!isPlainAgentId(agentId)) {
    return { error: 'agent_id must be a plain agent id (no path separators)' };
  }
  const toolCallId = query['tool_call_id'];
  if (toolCallId !== undefined && (typeof toolCallId !== 'string' || toolCallId.length === 0)) {
    return { error: 'tool_call_id must be a non-empty string' };
  }
  return { agentId, toolCallId: toolCallId as string | undefined };
}

function rosterOf(
  session: Session,
  agentId: string,
  snapshot: AgentTranscriptSnapshot,
): AgentDescriptorView[] {
  const roster: AgentDescriptorView[] = Object.keys(session.roster.getState().agents).map((id) => ({
    agentId: id,
    type: id === MAIN_AGENT_ID ? 'main' : 'sub',
  }));
  if (
    !roster.some((d) => d.agentId === agentId) &&
    (snapshot.items.length > 0 || snapshot.tasks.length > 0 || agentId === MAIN_AGENT_ID)
  ) {
    roster.push({ agentId, type: agentId === MAIN_AGENT_ID ? 'main' : 'sub' });
  }
  return roster;
}

function pendingInteractionIds(root: Parameters<typeof sessionFacade>[0], session: Session): string[] {
  const interactions = sessionFacade(root, InteractionRef, session.id);
  if (interactions === undefined) return [];
  return interactions
    .findAll({ resolved: false, tags: { [INTERACTION_TAG_SESSION_ID]: session.id } })
    .map((interaction) => interaction.id);
}

function interactionRecordsOf(
  root: Parameters<typeof sessionFacade>[0],
  session: Session,
  snapshot: AgentTranscriptSnapshot,
): readonly TranscriptInteraction[] {
  const live = new Map(snapshot.interactions.map((record) => [record.interactionId, record]));
  const interactions = sessionFacade(root, InteractionRef, session.id);
  if (interactions === undefined) return snapshot.interactions;
  const pending = interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_SESSION_ID]: session.id },
  });
  const out = [...live.values()];
  for (const interaction of pending) {
    if (live.has(interaction.id)) continue;
    if (interaction.kind !== 'approval' && interaction.kind !== 'question') continue;
    out.push(pendingRecordOf(interaction));
  }
  return out;
}

function pendingRecordOf(interaction: Interaction): TranscriptInteraction {
  const fromPayload = (interaction.payload as { toolCallId?: unknown } | undefined)?.toolCallId;
  const fromTags = interaction.tags['toolCallId'];
  const toolCallId =
    typeof fromPayload === 'string'
      ? fromPayload
      : typeof fromTags === 'string'
        ? fromTags
        : undefined;
  return {
    interactionId: interaction.id,
    interactionKind: interaction.kind === 'approval' ? 'approval' : 'question',
    toolCallId,
    state: 'pending',
    request: interaction.payload,
  };
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
        if (frame.kind !== 'tool' || frame.name !== EXIT_PLAN_MODE_TOOL_NAME) continue;
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
    (record) => record.interactionKind === 'approval' && record.toolCallId === toolCallId,
  );
  const review = readPlanReview(interaction);

  const request = interaction?.request;
  const requestDisplay =
    request !== undefined && request !== null && typeof request === 'object'
      ? (request as { display?: unknown }).display
      : undefined;
  const fromInteraction =
    readPlanReviewDisplay(requestDisplay) ?? readPlanReviewPayload(request);
  if (fromInteraction !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'interaction', ...fromInteraction, review };
  }
  const fromDisplay = readPlanReviewDisplay(frame.display);
  if (fromDisplay !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'display', ...fromDisplay, review };
  }
  const fromOutput = parsePlanFromOutput(planOutputText(frame.output));
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
    interaction.response !== undefined && interaction.response !== null && typeof interaction.response === 'object'
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
  if (d.kind !== 'plan_review') return undefined;
  return planDisplayFields(d);
}

function readPlanReviewPayload(payload: unknown): PlanReviewDisplayInfo | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  return planDisplayFields(payload as { plan?: unknown; path?: unknown; options?: unknown });
}

function planDisplayFields(d: {
  plan?: unknown;
  path?: unknown;
  options?: unknown;
}): PlanReviewDisplayInfo | undefined {
  if (typeof d.plan !== 'string' || d.plan.trim().length === 0) return undefined;
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

function planOutputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const text = output
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
      )
      .map((part) => part.text)
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function parsePlanFromOutput(output: string | undefined): { plan: string; path?: string } | undefined {
  if (output === undefined) return undefined;
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
