import { parseDaemonFileUrl, type PromptOrigin } from '@moonshot-ai/agent-core-v2';
import {
  isMediaPart,
  mediaKindOfPart,
  type ContentPart,
  type MediaPart,
} from '@moonshot-ai/agent-core-v2/human/llm/message';

import type {
  AgentRef,
  ConversationItem,
  ConversationOutcome,
  ConversationStatus,
  ConversationTurn,
  ConversationTurnHeader,
  ErrorInfo,
  Media,
  Notice,
  NotificationItem,
  PlanReviewDisplay,
  RetryState,
  StepSummary,
  StepTiming,
  ToolCallItem,
  ToolProgress,
  ToolStage,
  Usage,
  UserMessageItem,
  UserMessageOrigin,
} from '../../protocol/conversation';
import { interactionOutcome } from '../../protocol/interaction-wire';
import {
  STEP_TIMING_FIELDS,
  type FoldAgentRef,
  type FoldItem,
  type FoldNotification,
  type FoldStep,
  type FoldToolCall,
  type FoldTurn,
  type FoldUserMessage,
  type LiveToolProgress,
  type StepTimingField,
  type StepUsage,
  type TurnError,
  type TurnRetry,
} from './conversationFold';

export type MediaResolver = (url: string) => string;

export const keepMediaUrl: MediaResolver = (url) => url;

const TIMING_NAMES: Readonly<Record<StepTimingField, keyof StepTiming>> = {
  llmFirstTokenLatencyMs: 'first_token_ms',
  llmStreamDurationMs: 'stream_ms',
  llmRequestBuildMs: 'request_build_ms',
  llmServerFirstTokenMs: 'server_first_token_ms',
  llmServerDecodeMs: 'server_decode_ms',
  llmClientConsumeMs: 'client_consume_ms',
  llmClientBlockedMs: 'client_blocked_ms',
};

const CLIENT_SUBMITTED_ORIGINS: ReadonlySet<string> = new Set(['user', 'skill_activation', 'plugin_command']);
const EXIT_PLAN_MODE = 'ExitPlanMode';
const PLAN_SAVED_TO_MARKER = 'Plan saved to: ';
const PLAN_BODY_MARKERS = ['## Approved Plan:\n', '## Plan (auto-approved, not user-reviewed):\n'];

export const COMPACTION_CANCELLED_NOTICE: Notice = {
  level: 'warning',
  title: 'Context compaction did not finish',
  code: 'compaction.cancelled',
};

export function presentTurn(
  turn: FoldTurn,
  items: readonly FoldItem[],
  resolve: MediaResolver = keepMediaUrl,
): ConversationTurn {
  return { ...presentHeader(turn), items: items.map((item) => presentItem(item, resolve)) };
}

export function presentHeader(turn: FoldTurn): ConversationTurnHeader {
  const steps = presentSteps(turn.steps);
  const endedAt = turn.status === 'ended' ? turn.endedAt : undefined;
  return {
    turn_id: turn.id,
    ordinal: turn.ordinal,
    kind: turn.kind,
    status: turn.status,
    outcome: turn.outcome,
    end_reason: turn.endReason,
    error: turn.error === undefined ? undefined : presentError(turn.error),
    retry: turn.retry === undefined ? undefined : presentRetry(turn.retry),
    turn_number: turn.turnNumber,
    started_at: isoTime(turn.startedAt),
    ended_at: endedAt === undefined ? undefined : isoTime(endedAt),
    duration_ms: endedAt === undefined ? undefined : turn.durationMs ?? Math.max(0, endedAt - turn.startedAt),
    usage: totalUsage(steps),
    steps,
  };
}

export function presentItem(item: FoldItem, resolve: MediaResolver = keepMediaUrl): ConversationItem {
  switch (item.type) {
    case 'user_message':
      return presentUserMessage(item, resolve);
    case 'assistant_message':
      return {
        type: 'assistant_message',
        item_id: item.id,
        step_index: item.stepIndex,
        status: item.status,
        outcome: endedOutcome(item.status),
        created_at: isoTime(item.createdAt),
        text: item.text,
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        item_id: item.id,
        step_index: item.stepIndex,
        status: item.status,
        outcome: endedOutcome(item.status),
        created_at: isoTime(item.createdAt),
        text: item.text,
        started_at: isoTime(item.startedAt),
        duration_ms: item.durationMs,
      };
    case 'tool_call':
      return presentToolCall(item, resolve);
    case 'notification':
      return presentNotification(item);
    case 'system':
      return item.kind === 'compaction'
        ? {
            type: 'system',
            item_id: item.id,
            status: 'ended',
            outcome: 'completed',
            created_at: isoTime(item.createdAt),
            kind: 'compaction',
            trigger: item.trigger,
            instruction: item.instruction,
            tokens_before: item.tokensBefore,
            tokens_after: item.tokensAfter,
            compacted_count: item.compactedCount,
            summary: item.summary,
          }
        : {
            type: 'system',
            item_id: item.id,
            status: 'ended',
            outcome: 'completed',
            created_at: isoTime(item.createdAt),
            kind: 'fork_boundary',
            source: item.source,
            forked_from: { agent_id: item.forkedFrom },
          };
  }
}

export function mediaPartsOf(item: FoldItem): readonly MediaPart[] {
  if (item.type === 'user_message') return item.content.filter(isMediaPart);
  if (item.type !== 'tool_call' || item.result === undefined || item.result.isError) return [];
  const output = item.result.output;
  return typeof output === 'string' ? [] : output.filter(isMediaPart);
}

export function mediaUrl(part: MediaPart): string | undefined {
  const url = mediaFields(part)?.url;
  return typeof url === 'string' ? url : undefined;
}

export function warningNotice(message: string, code: string | undefined): Notice {
  return { level: 'warning', title: message, code };
}

export function errorNotice(error: {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly retryable?: boolean;
  readonly details?: unknown;
  readonly cause?: unknown;
}): Notice {
  const { name, retryable, details, cause } = error;
  const rest = Object.fromEntries(Object.entries({ name, retryable, details, cause }).filter(([, value]) => value !== undefined));
  return {
    level: 'error',
    title: error.message,
    code: error.code,
    detail: Object.keys(rest).length === 0 ? undefined : JSON.stringify(rest, null, 2),
  };
}

function presentSteps(steps: readonly FoldStep[]): StepSummary[] {
  const byIndex = new Map<number, StepSummary>();
  for (const step of steps) {
    if (step.endedAt !== undefined) byIndex.set(step.index, presentStep(step, step.endedAt));
  }
  return [...byIndex.values()].toSorted((a, b) => a.index - b.index);
}

function presentStep(step: FoldStep, endedAt: number): StepSummary {
  return {
    index: step.index,
    outcome: stepOutcome(step),
    started_at: isoTime(step.startedAt),
    ended_at: isoTime(endedAt),
    finish_reason: step.finishReason,
    usage: step.usage === undefined ? undefined : presentUsage(step.usage),
    timing: step.timing === undefined ? undefined : presentTiming(step.timing),
  };
}

function stepOutcome(step: FoldStep): ConversationOutcome {
  if (step.interruptReason !== undefined) return step.interruptReason === 'error' ? 'failed' : 'interrupted';
  if (step.finishReason === 'interrupted') return 'interrupted';
  if (step.finishReason === 'error') return 'failed';
  return 'completed';
}

function presentUsage(usage: StepUsage): Usage {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function totalUsage(steps: readonly StepSummary[]): Usage | undefined {
  let total: Usage | undefined;
  for (const { usage } of steps) {
    if (usage === undefined) continue;
    total = {
      input_other: (total?.input_other ?? 0) + usage.input_other,
      output: (total?.output ?? 0) + usage.output,
      input_cache_read: (total?.input_cache_read ?? 0) + usage.input_cache_read,
      input_cache_creation: (total?.input_cache_creation ?? 0) + usage.input_cache_creation,
    };
  }
  return total;
}

function presentTiming(timing: Partial<Record<StepTimingField, number>>): StepTiming {
  const presented: StepTiming = {};
  for (const field of STEP_TIMING_FIELDS) {
    const value = timing[field];
    if (value !== undefined) presented[TIMING_NAMES[field]] = value;
  }
  return presented;
}

function presentError(error: TurnError): ErrorInfo {
  return {
    code: error.code,
    message: error.message,
    name: error.name,
    status_code: error.statusCode,
    request_id: error.requestId,
    retryable: error.retryable,
  };
}

function presentRetry(retry: TurnRetry): RetryState {
  return {
    attempt: retry.attempt,
    next_attempt: retry.nextAttempt,
    max_attempts: retry.maxAttempts,
    delay_ms: Math.max(0, Math.round(retry.delayMs)),
    error: { name: retry.errorName, message: retry.errorMessage, status_code: retry.statusCode },
  };
}

function presentUserMessage(item: FoldUserMessage, resolve: MediaResolver): UserMessageItem {
  const origin = item.origin;
  return {
    type: 'user_message',
    item_id: item.id,
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(item.createdAt),
    prompt_ids: CLIENT_SUBMITTED_ORIGINS.has(origin?.kind ?? 'user') ? [...item.promptIds] : [],
    placement: item.placement,
    origin: presentOrigin(origin),
    text: item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
    attachments: item.content.filter(isMediaPart).map((part, index) => {
      const name = mediaFields(part)?.name;
      return { ...presentMedia(part, resolve), name: typeof name === 'string' ? name : undefined, ordinal: index + 1 };
    }),
    skills: origin?.kind === 'user'
      ? (origin.skillActivations ?? []).map(({ skillName, skillArgs }) => ({ name: skillName, args: skillArgs }))
      : [],
    client_metadata: origin?.kind === 'user' || origin?.kind === 'skill_activation' ? origin.clientMetadata?.[0] : undefined,
  };
}

function presentOrigin(origin: PromptOrigin | undefined): UserMessageOrigin {
  switch (origin?.kind) {
    case undefined:
    case 'user':
      return { kind: 'user' };
    case 'skill_activation':
      return { kind: 'skill', name: origin.skillName, args: origin.skillArgs };
    case 'plugin_command':
      return { kind: 'plugin_command', plugin_id: origin.pluginId, command: origin.commandName, args: origin.commandArgs };
    case 'cron_job':
      return {
        kind: 'cron',
        job_id: origin.jobId,
        schedule: origin.cron,
        recurring: origin.recurring,
        coalesced_count: origin.coalescedCount ?? 1,
        stale: origin.stale ?? false,
      };
    case 'hook_result':
      return { kind: 'hook', hook_event: origin.event };
    case 'system_trigger':
      return origin.name === 'goal_continuation' ? { kind: 'goal' } : { kind: 'system' };
    case 'retry':
      return { kind: 'retry' };
    default:
      return { kind: 'system' };
  }
}

function mediaFields(part: MediaPart): { readonly url?: unknown; readonly name?: unknown } | undefined {
  if (part.type === 'image_url') return part.imageUrl;
  return part.type === 'video_url' ? part.videoUrl : part.audioUrl;
}

function presentMedia(part: MediaPart, resolve: MediaResolver): Media {
  const raw = mediaUrl(part) ?? '';
  const fileId = parseDaemonFileUrl(raw)?.fileId;
  const url = fileId === undefined ? resolve(raw) : undefined;
  return {
    kind: mediaKindOfPart(part),
    file_id: fileId,
    url,
    media_type: url === undefined ? undefined : /^data:([^;,]+)[;,]/.exec(url)?.[1],
  };
}

function presentToolCall(item: FoldToolCall, resolve: MediaResolver): ToolCallItem {
  const result = item.result;
  const failed = result?.isError === true;
  const media = result === undefined || failed ? [] : mediaPartsOf(item).map((part) => presentMedia(part, resolve));
  return {
    type: 'tool_call',
    item_id: item.id,
    step_index: item.stepIndex,
    status: item.status,
    outcome: item.outcome,
    created_at: isoTime(item.createdAt),
    name: item.name,
    stage: item.status === 'running' ? toolStage(item) : undefined,
    input: item.input,
    input_text: item.live?.inputText,
    display: item.name === EXIT_PLAN_MODE ? planReview(item) ?? item.display : item.display,
    output: result === undefined ? item.live?.output : failed ? undefined : resultText(result.output),
    media: media.length === 0 ? undefined : media,
    error: failed ? resultText(result.output) : undefined,
    progress: item.live?.progress === undefined ? undefined : presentProgress(item.live.progress),
    interaction_id: item.interaction?.id,
    agent_refs: item.agentRefs?.map(presentAgentRef),
    started_at: isoTime(item.startedAt),
    ended_at: item.endedAt === undefined ? undefined : isoTime(item.endedAt),
  };
}

function toolStage(item: FoldToolCall): ToolStage {
  if (item.interaction?.pending === true && item.interaction.kind === 'approval') return 'awaiting_approval';
  return item.streaming === true ? 'input' : 'executing';
}

function presentProgress(progress: LiveToolProgress): ToolProgress {
  return {
    percent: progress.percent,
    status: progress.status,
    custom_kind: progress.customKind,
    custom_data: progress.customData,
  };
}

function presentAgentRef(ref: FoldAgentRef): AgentRef {
  return {
    agent_id: ref.agentId,
    role: ref.swarmIndex === undefined ? 'child' : 'member',
    swarm_index: ref.swarmIndex,
    task_id: ref.taskId,
  };
}

function resultText(output: string | readonly ContentPart[]): string {
  if (typeof output === 'string') return output;
  return output.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function planReview(item: FoldToolCall): PlanReviewDisplay | undefined {
  const content =
    planDisplayContent((item.interaction?.request as { display?: unknown } | undefined)?.display) ??
    planDisplayContent(item.display) ??
    planOutputContent(item.result === undefined ? undefined : resultText(item.result.output));
  if (content === undefined) return undefined;
  return { kind: 'plan_review', ...content, review: planReviewState(item) };
}

type PlanContent = Pick<PlanReviewDisplay, 'plan' | 'path' | 'options'>;

function planDisplayContent(display: unknown): PlanContent | undefined {
  if (display === null || typeof display !== 'object') return undefined;
  const candidate = display as { kind?: unknown; plan?: unknown; path?: unknown; options?: unknown };
  if (candidate.kind !== 'plan_review' || typeof candidate.plan !== 'string' || candidate.plan.trim().length === 0) {
    return undefined;
  }
  const options = Array.isArray(candidate.options)
    ? candidate.options.flatMap((option: unknown) => {
        if (option === null || typeof option !== 'object') return [];
        const { label, description } = option as { label?: unknown; description?: unknown };
        const text = nonEmpty(label);
        return text === undefined ? [] : [{ label: text, description: typeof description === 'string' ? description : '' }];
      })
    : [];
  return { plan: candidate.plan, path: typeof candidate.path === 'string' ? candidate.path : undefined, options };
}

function planOutputContent(output: string | undefined): PlanContent | undefined {
  if (output === undefined) return undefined;
  const pathLine = output.split('\n').find((line) => line.startsWith(PLAN_SAVED_TO_MARKER));
  const path = pathLine === undefined ? undefined : nonEmpty(pathLine.slice(PLAN_SAVED_TO_MARKER.length).trim());
  for (const marker of PLAN_BODY_MARKERS) {
    const index = output.indexOf(marker);
    if (index === -1) continue;
    const plan = output.slice(index + marker.length);
    if (plan.trim().length > 0) return { plan, path, options: [] };
  }
  return undefined;
}

function planReviewState(item: FoldToolCall): PlanReviewDisplay['review'] {
  const interaction = item.interaction;
  if (interaction?.kind === 'approval') {
    if (interaction.pending) return { state: 'pending' };
    const outcome = interactionOutcome('approval', interaction.response);
    const response = (interaction.response ?? {}) as { selectedLabel?: unknown; feedback?: unknown };
    return {
      state: outcome === 'approved' || outcome === 'rejected' ? outcome : 'cancelled',
      selected_option: nonEmpty(response.selectedLabel),
      feedback: nonEmpty(response.feedback),
    };
  }
  if (item.status === 'running') return { state: 'pending' };
  return { state: item.outcome === 'completed' ? 'approved' : 'cancelled' };
}

function presentNotification(item: FoldNotification): NotificationItem {
  const notification = item.notification;
  const output = notification.output;
  return {
    type: 'notification',
    item_id: item.id,
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(item.createdAt),
    notification_id: notification.id,
    title: notification.title,
    body: notification.body,
    severity: notification.severity,
    notification_type: notification.type,
    source: { kind: notification.sourceKind, id: notification.sourceId },
    task_id: notification.sourceKind === 'background_task' ? notification.sourceId : undefined,
    agent_id: notification.agentId,
    output: output === undefined
      ? undefined
      : { file: output.file, preview: output.preview, bytes: output.bytes, truncated: output.truncated },
  };
}

function endedOutcome(status: ConversationStatus): ConversationOutcome | undefined {
  return status === 'ended' ? 'completed' : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
