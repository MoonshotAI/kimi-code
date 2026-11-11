import { matchSingleMediaPathTag, parseDaemonFileUrl, type PromptOrigin } from '@moonshot-ai/agent-core-v2';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import {
  isMediaPart,
  mediaKindOfPart,
  type ContentPart,
  type MediaPart,
} from '@moonshot-ai/agent-core-v2/human/llm/message';

import type {
  AgentRef,
  AssistantMessageItem,
  Attachment,
  ConversationOutcome,
  ErrorInfo,
  Media,
  NotificationItem,
  PlanReviewDisplay,
  ReasoningItem,
  RequestDebug,
  RequestTiming,
  RetryState,
  StepSummary,
  ToolCallItem,
  Usage,
  UserMessageItem,
  UserMessageOrigin,
} from '../../protocol/conversation';
import { interactionOutcome } from '../../protocol/interaction-wire';
import type { TaskNotification } from './taskNotifications';

export interface ToolInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question' | 'user_tool';
  readonly request?: unknown;
  pending: boolean;
  response?: unknown;
}

type StepEndEvent = Extract<LoopRecordedEvent, { type: 'step.end' }>;

const CLIENT_SUBMITTED_ORIGINS: ReadonlySet<UserMessageOrigin['kind']> = new Set(['user', 'skill', 'plugin_command']);
const EXIT_PLAN_MODE = 'ExitPlanMode';
const PLAN_SAVED_TO_MARKER = 'Plan saved to: ';
const PLAN_BODY_MARKERS = ['## Approved Plan:\n', '## Plan (auto-approved, not user-reviewed):\n'];
const CRON_FIRE_ENVELOPE = /^<cron-fire [^\n]*>\n<prompt>\n([\s\S]*)\n<\/prompt>\n<\/cron-fire>$/;
const ATTACHED_FILE_NOTICE = /^Attached file "(.+)" \((.+), (\d+) bytes\): (.+) — open it with the Read tool$/s;
const FILE_ID = String.raw`f_(?:[0-9A-Za-z]{26}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})`;
const UPLOADED_FILE_PATH = new RegExp(String.raw`(?:^|[\\/])(${FILE_ID})-[^\\/]*$`);
const CACHED_MEDIA_PATH = new RegExp(String.raw`(?:^|[\\/])(${FILE_ID})\.[^\\/.]+$`);
const IMAGE_COMPRESSION_CAPTION = /^<system>Image compressed to fit model limits:[\s\S]*<\/system>$/;
const REQUEST_TIMING_NAMES = {
  llmFirstTokenLatencyMs: 'first_token_ms',
  llmStreamDurationMs: 'stream_ms',
  llmRequestBuildMs: 'request_build_ms',
  llmServerFirstTokenMs: 'server_first_token_ms',
  llmServerDecodeMs: 'server_decode_ms',
  llmClientConsumeMs: 'client_consume_ms',
  llmClientBlockedMs: 'client_blocked_ms',
} as const satisfies Record<string, keyof RequestTiming>;

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

export function userMessageItem(
  id: string,
  placement: UserMessageItem['placement'],
  promptId: string | undefined,
  origin: PromptOrigin | undefined,
  content: readonly ContentPart[],
  time: number,
): UserMessageItem {
  const presented = originOf(origin);
  const text: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      const file = ATTACHED_FILE_NOTICE.exec(part.text);
      const tag = file === null ? matchSingleMediaPathTag(part.text) : undefined;
      const cachedId = tag !== undefined && tag.kind !== 'file' ? CACHED_MEDIA_PATH.exec(tag.path)?.[1] : undefined;
      if (file !== null) {
        const [, name, mediaType, size, path] = file;
        const fileId = UPLOADED_FILE_PATH.exec(path!)?.[1];
        attachments.push({ kind: 'file', file_id: fileId, name, media_type: mediaType, size: Number(size), ordinal: attachments.length + 1 });
      } else if (tag !== undefined && tag.kind !== 'file' && cachedId !== undefined) {
        attachments.push({ kind: tag.kind, file_id: cachedId, ordinal: attachments.length + 1 });
      } else if (!IMAGE_COMPRESSION_CAPTION.test(part.text)) {
        text.push(part.text);
      }
    } else if (isMediaPart(part)) {
      const name = mediaFields(part)?.name;
      attachments.push({ ...mediaOf(part), name: typeof name === 'string' ? name : undefined, ordinal: attachments.length + 1 });
    }
  }
  return {
    type: 'user_message',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(time),
    prompt_ids: promptIdsOf(presented, promptId === undefined ? [] : [promptId]),
    placement,
    origin: presented,
    text: presented.kind === 'cron' ? cronPromptOf(text.join('\n')) : text.join('\n'),
    attachments,
    skills: origin?.kind === 'user'
      ? (origin.skillActivations ?? []).map(({ skillName, skillPath, skillArgs }) => ({ name: skillName, path: skillPath, args: skillArgs }))
      : [],
    metadata: origin?.kind === 'user' || origin?.kind === 'skill_activation' ? origin.clientMetadata?.[0] : undefined,
  };
}

export function promptIdsOf(origin: UserMessageOrigin, promptIds: readonly string[]): string[] {
  return CLIENT_SUBMITTED_ORIGINS.has(origin.kind) ? [...promptIds] : [];
}

export function contentItem(
  part: ContentPart,
  id: string,
  stepIndex: number | undefined,
  createdAt: number,
  durationMs?: number,
): AssistantMessageItem | ReasoningItem | undefined {
  const base = { item_id: id, step_index: stepIndex, status: 'ended', outcome: 'completed', created_at: isoTime(createdAt) } as const;
  if (part.type === 'text') return { type: 'assistant_message', ...base, text: part.text };
  if (part.type === 'think' && part.hidden !== true) {
    return { type: 'reasoning', ...base, text: part.think, started_at: isoTime(createdAt), duration_ms: durationMs };
  }
  return undefined;
}

export function toolCallItem(
  id: string,
  name: string,
  stepIndex: number | undefined,
  time: number,
  input: unknown,
  display: unknown,
): ToolCallItem {
  return {
    type: 'tool_call',
    item_id: id,
    step_index: stepIndex,
    status: 'running',
    created_at: isoTime(time),
    name,
    stage: 'executing',
    input,
    display,
    started_at: isoTime(time),
  };
}

export function isPlanTool(name: string): boolean {
  return name === EXIT_PLAN_MODE;
}

export function endToolCall(
  item: ToolCallItem,
  output: string | readonly ContentPart[],
  outcome: 'completed' | 'failed' | 'interrupted',
  note: string | undefined,
  time: number,
): void {
  const text = resultText(output);
  const completed = outcome === 'completed';
  const media = !completed || typeof output === 'string' ? [] : output.filter(isMediaPart).map(mediaOf);
  item.status = 'ended';
  item.outcome = outcome;
  item.output = completed ? text : undefined;
  item.error = completed ? undefined : text;
  item.note = note;
  item.media = media.length === 0 ? undefined : media;
  item.ended_at = isoTime(time);
}

export function refreshToolCall(item: ToolCallItem, interaction: ToolInteraction | undefined, planDisplay: unknown): void {
  item.interaction_id = interaction?.id;
  item.stage = item.status !== 'running'
    ? undefined
    : interaction?.pending === true && interaction.kind === 'approval' ? 'awaiting_approval' : 'executing';
  if (isPlanTool(item.name)) item.display = planReview(item, interaction, planDisplay) ?? planDisplay;
}

export function agentRefOf(agentId: string, swarmIndex: number | undefined, taskId: string | undefined): AgentRef {
  return { agent_id: agentId, role: swarmIndex === undefined ? 'child' : 'member', swarm_index: swarmIndex, task_id: taskId };
}

export function notificationItem(id: string, notification: TaskNotification, time: number): NotificationItem {
  const output = notification.output;
  return {
    type: 'notification',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(time),
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
    answer: notification.answer === undefined
      ? undefined
      : { answers: { ...notification.answer.answers }, note: notification.answer.note },
  };
}

export function stepSummary(
  index: number,
  startedAt: number,
  endedAt: number,
  interruptReason: string | undefined,
  end: StepEndEvent,
): StepSummary {
  return {
    index,
    outcome: stepOutcome(interruptReason, end.finishReason),
    started_at: isoTime(startedAt),
    ended_at: isoTime(endedAt),
    finish_reason: end.finishReason,
    usage: usageOf(end),
  };
}

export function requestDebug(end: StepEndEvent): RequestDebug {
  const timing: RequestTiming = {};
  for (const [field, name] of Object.entries(REQUEST_TIMING_NAMES) as [keyof typeof REQUEST_TIMING_NAMES, keyof RequestTiming][]) {
    const value = end[field];
    if (typeof value === 'number') timing[name] = value;
  }
  return {
    finish_reason: end.finishReason,
    usage: usageOf(end),
    timing: Object.keys(timing).length === 0 ? undefined : timing,
  };
}

function usageOf(end: StepEndEvent): Usage | undefined {
  return end.usage === undefined
    ? undefined
    : {
        input_other: end.usage.inputOther ?? 0,
        output: end.usage.output ?? 0,
        input_cache_read: end.usage.inputCacheRead ?? 0,
        input_cache_creation: end.usage.inputCacheCreation ?? 0,
      };
}

export function stepOutcome(interruptReason: string | undefined, finishReason: string | undefined): ConversationOutcome {
  if (interruptReason !== undefined) return interruptReason === 'error' ? 'failed' : 'interrupted';
  if (finishReason === 'interrupted') return 'interrupted';
  if (finishReason === 'error') return 'failed';
  return 'completed';
}

export function totalUsage(steps: readonly StepSummary[]): Usage | undefined {
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

export function errorInfoOf(error: unknown, requestId: string | undefined): ErrorInfo | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const payload = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    retryable?: unknown;
    details?: { statusCode?: unknown; requestId?: unknown };
  };
  if (typeof payload.message !== 'string') return undefined;
  return {
    code: typeof payload.code === 'string' ? payload.code : 'internal',
    message: payload.message,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    status_code: typeof payload.details?.statusCode === 'number' ? payload.details.statusCode : undefined,
    request_id: typeof payload.details?.requestId === 'string' ? payload.details.requestId : requestId,
    retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
  };
}

export function retryStateOf(retry: {
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}): RetryState {
  return {
    attempt: retry.attempt,
    next_attempt: retry.nextAttempt,
    max_attempts: retry.maxAttempts,
    delay_ms: Math.max(0, Math.round(retry.delayMs)),
    error: { name: retry.errorName, message: retry.errorMessage, status_code: retry.statusCode },
  };
}

export function mediaPartOf(media: Pick<Media, 'kind'> & { readonly url: string }): MediaPart {
  switch (media.kind) {
    case 'image':
      return { type: 'image_url', imageUrl: { url: media.url } };
    case 'video':
      return { type: 'video_url', videoUrl: { url: media.url } };
    case 'audio':
      return { type: 'audio_url', audioUrl: { url: media.url } };
  }
}

export function mediaUrlOf(part: MediaPart): string | undefined {
  const url = mediaFields(part)?.url;
  return typeof url === 'string' ? url : undefined;
}

export function mediaTypeOf(url: string): string | undefined {
  return /^data:([^;,]+)[;,]/.exec(url)?.[1];
}

function cronPromptOf(text: string): string {
  return CRON_FIRE_ENVELOPE.exec(text)?.[1] ?? text;
}

function originOf(origin: PromptOrigin | undefined): UserMessageOrigin {
  switch (origin?.kind) {
    case undefined:
    case 'user':
      return { kind: 'user' };
    case 'skill_activation':
      return { kind: 'skill', name: origin.skillName, path: origin.skillPath, args: origin.skillArgs };
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

function mediaOf(part: MediaPart): Media {
  const raw = mediaUrlOf(part) ?? '';
  const fileId = parseDaemonFileUrl(raw)?.fileId;
  const url = fileId === undefined ? raw : undefined;
  return {
    kind: mediaKindOfPart(part),
    file_id: fileId,
    url,
    media_type: url === undefined ? undefined : mediaTypeOf(url),
  };
}

function resultText(output: string | readonly ContentPart[]): string {
  if (typeof output === 'string') return output;
  return output.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function planReview(
  item: ToolCallItem,
  interaction: ToolInteraction | undefined,
  planDisplay: unknown,
): PlanReviewDisplay | undefined {
  const content =
    planDisplayContent((interaction?.request as { display?: unknown } | undefined)?.display) ??
    planDisplayContent(planDisplay) ??
    planOutputContent(item.output ?? item.error);
  if (content === undefined) return undefined;
  return { kind: 'plan_review', ...content, review: planReviewState(item, interaction) };
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

function planReviewState(item: ToolCallItem, interaction: ToolInteraction | undefined): PlanReviewDisplay['review'] {
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

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
