/**
 * Plan derivation from the message stream — the new-protocol replacement
 * for the removed `GET /transcript/plan` endpoint.
 *
 * Under the message protocol there is no plan lookup endpoint; the data
 * lives in the timeline itself: the EnterPlanMode/ExitPlanMode tool calls,
 * the approval interaction that carries the review (its
 * `request.tool_input_display` holds the `plan_review` display payload with
 * the plan content, path and offered options; its `response` holds the
 * decision, selected label and feedback), and the `system(plan.revision)`
 * version marker (its payload path points at the plan document).
 * `session.state.modes.plan` mirrors the current mode/revision over the WS
 * but is not part of REST history, so derivation here runs purely over a
 * history message list (in timeline order).
 */

import type {
  HistoryMessage,
  InteractionMessage,
  ToolCallMessage,
} from '@moonshot-ai/kap-server/protocol';

export interface PlanReview {
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly selectedOption?: string;
  readonly feedback?: string;
}

export interface PlanInfo {
  readonly toolCallId: string;
  readonly turnId: string;
  /** Which message the content was derived from. */
  readonly source: 'interaction' | 'display' | 'output';
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { label: string; description?: string }[];
  readonly review?: PlanReview;
}

export function projectPlans(
  messages: readonly HistoryMessage[],
  toolCallId?: string,
): PlanInfo[] {
  const interactions: InteractionMessage[] = [];
  const revisionPaths: string[] = [];
  for (const message of messages) {
    if (message.type === 'interaction') interactions.push(message);
    if (message.type === 'system' && message.subtype === 'plan.revision') {
      const path = readRevisionPath(message.payload);
      if (path !== undefined) revisionPaths.push(path);
    }
  }
  const plans: PlanInfo[] = [];
  for (const message of messages) {
    if (message.type !== 'tool_call' || message.name !== 'ExitPlanMode') continue;
    if (toolCallId !== undefined && message.tool_call_id !== toolCallId) continue;
    const info = projectPlanCall(message, interactions);
    if (info === undefined) continue;
    plans.push(
      info.path === undefined && revisionPaths.length > 0
        ? { ...info, path: revisionPaths.at(-1) }
        : info,
    );
  }
  return plans;
}

function projectPlanCall(
  call: ToolCallMessage,
  interactions: readonly InteractionMessage[],
): PlanInfo | undefined {
  const interaction = interactions.find(
    (candidate) =>
      candidate.kind === 'approval' &&
      (candidate.interaction_id === call.approval_id ||
        (call.approval_id === undefined && candidate.tool_call_id === call.tool_call_id)),
  );
  const review = readPlanReview(interaction);
  if (interaction !== undefined && interaction.kind === 'approval') {
    const fromInteraction = readPlanReviewDisplay(interaction.request?.tool_input_display);
    if (fromInteraction !== undefined) {
      return {
        toolCallId: call.tool_call_id,
        turnId: call.turn_id,
        source: 'interaction',
        ...fromInteraction,
        review,
      };
    }
  }
  const fromDisplay = readPlanReviewDisplay(call.display);
  if (fromDisplay !== undefined) {
    return {
      toolCallId: call.tool_call_id,
      turnId: call.turn_id,
      source: 'display',
      ...fromDisplay,
      review,
    };
  }
  const fromOutput = parsePlanFromOutput(call.output);
  if (fromOutput !== undefined) {
    return {
      toolCallId: call.tool_call_id,
      turnId: call.turn_id,
      source: 'output',
      ...fromOutput,
      review,
    };
  }
  return undefined;
}

function readPlanReview(interaction: InteractionMessage | undefined): PlanReview | undefined {
  if (interaction === undefined || interaction.kind !== 'approval') return undefined;
  const state = interaction.state;
  if (state !== 'pending' && state !== 'approved' && state !== 'rejected' && state !== 'cancelled') {
    return undefined;
  }
  const response = interaction.response;
  const selected =
    typeof response?.selected_label === 'string' && response.selected_label.length > 0
      ? response.selected_label
      : undefined;
  const feedback =
    typeof response?.feedback === 'string' && response.feedback.length > 0
      ? response.feedback
      : undefined;
  return { state, selectedOption: selected, feedback };
}

interface PlanReviewDisplayInfo {
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { label: string; description?: string }[];
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

function readRevisionPath(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const path = (payload as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
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
