import type { AppMessage, AppMessageContent, AppTurnError, AppTurnRetry, SessionPlan } from '../api/types';
import { isModelSupportedImageMime } from '../lib/mediaMime';
import { normalizeToolName } from '../lib/normalizeToolName';
import { isNotifyUserTool } from '../lib/notifyUser';
import type {
  CompactionItem,
  ConversationAttachment,
  ConversationItem,
  ConversationMedia,
  ConversationRequestDebug,
  ConversationTurn,
  NotificationItem,
  PlanReviewDisplay,
  ToolCallItem,
  UserMessageItem,
} from '../conversation/types';
import { turnResult, undoableOpener } from '../conversation/reducer';
import {
  agentIdFromOutput,
  normalizeToolMedia,
  normalizeToolOutput,
  parsePlanSavedPath,
  toolResultText,
  withReadMediaDetails,
} from './toolCalls';
import type { ChatTurn, TaskNotification, ToolCall, ToolMedia, TurnAttachment, TurnBlock } from './types';
import { mcpAuthCardOf } from './mcpAuthCard';
import { inlineReferencedIndexes } from './userMessageText';

export interface ConversationProjectionOptions {
  readonly sessionId: string;
  readonly getFileUrl?: (fileId: string) => string;
  readonly getSessionMediaUrl?: (sessionId: string, fileId: string) => string;
}

export interface ConversationProjector {
  (turns: readonly ConversationTurn[], options: ConversationProjectionOptions): ChatTurn[];
}

interface Segment {
  readonly turns: readonly ConversationTurn[];
  readonly startNo: number;
  readonly options: ConversationProjectionOptions;
  readonly out: ChatTurn[];
}

interface AssistantGroup {
  readonly chat: ChatTurn;
  promptId: string | undefined;
  readonly turns: ConversationTurn[];
  readonly textParts: string[];
  readonly thinkingParts: string[];
  readonly tools: ToolCall[];
  readonly blocks: TurnBlock[];
  candidate: Extract<TurnBlock, { kind: 'text' }> | undefined;
}

type ThinkingBlock = Extract<TurnBlock, { kind: 'thinking' }>;

const toolCalls = new WeakMap<ToolCallItem, { readonly sessionId: string; readonly tool: ToolCall }>();

export function createConversationProjector(): ConversationProjector {
  let previous = new Map<string, Segment>();
  let previousOut: ChatTurn[] = [];
  return (turns, options) => {
    const next = new Map<string, Segment>();
    const out: ChatTurn[] = [];
    let numbered = 0;
    let reused = true;
    for (const segmentTurns of splitSegments(turns)) {
      const startNo = numbered + 1;
      const cached = previous.get(segmentTurns[0]!.turn_id);
      const hit =
        cached !== undefined &&
        cached.startNo === startNo &&
        sameOptions(cached.options, options) &&
        cached.turns.length === segmentTurns.length &&
        segmentTurns.every((turn, index) => cached.turns[index] === turn);
      const segment = hit ? cached : { turns: segmentTurns, startNo, options, out: projectTurns(segmentTurns, startNo, options) };
      if (!hit) reused = false;
      next.set(segmentTurns[0]!.turn_id, segment);
      for (const turn of segment.out) {
        out.push(turn);
        if (turn.role !== 'compaction') numbered += 1;
      }
    }
    if (reused && next.size === previous.size) return previousOut;
    previous = next;
    previousOut = out;
    return out;
  };
}

export function conversationToTurns(
  turns: readonly ConversationTurn[],
  options: ConversationProjectionOptions,
): ChatTurn[] {
  return createConversationProjector()(turns, options);
}

export function pendingPromptTurn(message: AppMessage, no: number, options: ConversationProjectionOptions): ChatTurn {
  const metadata = message.metadata ?? {};
  const origin = metadata['origin'] as
    | {
        kind?: string;
        skillName?: string;
        skillPath?: string;
        skillArgs?: string;
        skillActivations?: readonly { skillName: string; skillPath?: string; skillArgs?: string }[];
      }
    | undefined;
  const skill = origin?.kind === 'skill_activation' && origin.skillName !== undefined
    ? { name: origin.skillName, path: origin.skillPath, args: origin.skillArgs }
    : undefined;
  const bundled = origin?.kind === 'user' ? origin.skillActivations ?? [] : [];
  const steered = metadata['kimiWeb.steered'] === true;
  const promptId = message.promptId ?? metadata['kimiWeb.promptId'];
  const snapshot = metadata['kimiWeb.composerSnapshot'];
  return withAttachments(
    {
      id: message.id,
      clientMetadata: snapshot === undefined ? undefined : [{ kimi_code_composer: snapshot }],
      role: 'user',
      no,
      text: skill === undefined ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n') : skill.args ?? '',
      steered: steered || undefined,
      steerPhase: steered ? (metadata['kimiWeb.steerPhase'] as 'sending' | 'accepted' | undefined) ?? 'sending' : undefined,
      promptIds: typeof promptId === 'string' ? [promptId] : undefined,
      skillActivation: skill,
      skillActivations: bundled.length > 0 ? bundled.map((activation) => ({ name: activation.skillName, path: activation.skillPath, args: activation.skillArgs })) : undefined,
      createdAt: message.createdAt,
    },
    message.content.flatMap((part) => pendingAttachmentOf(part, message.sessionId, options)),
  );
}

export function conversationTurnError(turn: ConversationTurn | undefined): AppTurnError | undefined {
  if (turn === undefined || turn.status !== 'ended' || turn.outcome !== 'failed' || turn.error === undefined) {
    return undefined;
  }
  return {
    code: turn.error.code,
    message: turn.error.message,
    name: turn.error.name,
    retryable: turn.error.retryable,
    statusCode: turn.error.status_code,
    requestId: turn.error.request_id,
    endReason: turn.end_reason,
  };
}

export function conversationTurnRetry(turn: ConversationTurn | undefined): AppTurnRetry | undefined {
  const retry = turn?.status === 'running' ? turn.retry : undefined;
  if (retry === undefined) return undefined;
  return {
    failedAttempt: retry.attempt,
    nextAttempt: retry.next_attempt,
    maxAttempts: retry.max_attempts,
    delayMs: retry.delay_ms,
    errorName: retry.error.name,
    statusCode: retry.error.status_code,
  };
}

export function sessionPlansOf(turns: readonly ConversationTurn[]): Record<string, SessionPlan> {
  const plans: Record<string, SessionPlan> = {};
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'tool_call') continue;
      const plan = planOf(item);
      if (plan !== undefined) plans[item.item_id] = plan;
    }
  }
  return plans;
}

function splitSegments(turns: readonly ConversationTurn[]): ConversationTurn[][] {
  const segments: ConversationTurn[][] = [];
  for (const turn of turns) {
    const current = segments.at(-1);
    const first = turn.items[0];
    if (current === undefined || (first?.type === 'user_message' && first.placement === 'opener')) segments.push([turn]);
    else current.push(turn);
  }
  return segments;
}

function sameOptions(a: ConversationProjectionOptions, b: ConversationProjectionOptions): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.getFileUrl === b.getFileUrl &&
    a.getSessionMediaUrl === b.getSessionMediaUrl
  );
}

function projectTurns(turns: readonly ConversationTurn[], startNo: number, options: ConversationProjectionOptions): ChatTurn[] {
  const out: ChatTurn[] = [];
  let no = startNo;
  let group: AssistantGroup | undefined;

  const close = (keepEmpty: boolean): void => {
    const g = group;
    group = undefined;
    if (g === undefined || (!keepEmpty && g.blocks.length === 0)) return;
    const numbered = g.turns.filter((turn) => turn.turn_number !== undefined);
    const last = numbered.at(-1);
    Object.assign(g.chat, {
      no: no++,
      text: g.textParts.join('\n'),
      thinking: g.thinkingParts.length > 0 ? g.thinkingParts.join('\n') : undefined,
      tools: g.tools.length > 0 ? g.tools : undefined,
      blocks: g.blocks.length > 0 ? mergeBlocks(g.blocks) : undefined,
      daemonTurnId: numbered[0]?.turn_number,
      forkTurnIndex: last?.turn_number,
      daemonTurnState: last === undefined ? undefined : turnResult(last),
    });
    out.push(g.chat);
  };

  const open = (id: string, promptId: string | undefined, turn: ConversationTurn, createdAt: string, goalContinuation?: true): AssistantGroup => {
    close(false);
    group = {
      chat: { id, sessionId: options.sessionId, role: 'assistant', no: 0, text: '', createdAt, goalContinuation },
      promptId,
      turns: [turn],
      textParts: [],
      thinkingParts: [],
      tools: [],
      blocks: [],
      candidate: undefined,
    };
    return group;
  };

  const markFinal = (): void => {
    if (group?.candidate !== undefined) group.candidate.final = true;
    if (group !== undefined) group.candidate = undefined;
  };

  const absorb = (g: AssistantGroup, turn: ConversationTurn): AssistantGroup => {
    if (g.turns.at(-1) !== turn) g.turns.push(turn);
    return g;
  };

  const continues = (g: AssistantGroup | undefined, promptId: string | undefined): g is AssistantGroup =>
    g !== undefined && (g.promptId === undefined || promptId === undefined || g.promptId === promptId);

  const assistantGroup = (turn: ConversationTurn, promptId: string | undefined, id: string, createdAt: string): AssistantGroup => {
    if (!continues(group, promptId)) return open(id, promptId, turn, createdAt);
    group.promptId ??= promptId;
    return absorb(group, turn);
  };

  const userMessage = (item: UserMessageItem, turn: ConversationTurn, promptId: string | undefined): void => {
    const origin = item.origin;
    switch (origin.kind) {
      case 'cron':
        if (item.text.length === 0) return;
        markFinal();
        close(false);
        out.push({
          id: item.item_id,
          role: 'cron',
          no: no++,
          text: item.text,
          createdAt: item.created_at,
          cron: { jobId: origin.job_id, cron: origin.schedule, recurring: origin.recurring, coalescedCount: origin.coalesced_count, stale: origin.stale },
        });
        return;
      case 'goal':
        markFinal();
        close(false);
        out.push({ id: `${item.item_id}-goal`, role: 'goal', no: no++, text: item.text, createdAt: item.created_at });
        open(item.item_id, undefined, turn, item.created_at, true);
        return;
      case 'user':
        if (item.text.length === 0 && item.attachments.length === 0 && item.skills.length === 0) return;
        break;
      case 'skill':
      case 'plugin_command':
        break;
      case 'system':
        if (item.text.length > 0 || item.attachments.length > 0) break;
        if (item.placement === 'opener') {
          markFinal();
          close(false);
        }
        return;
      default:
        if (item.placement === 'opener') {
          markFinal();
          close(false);
        }
        return;
    }
    markFinal();
    close(false);
    out.push(userTurn(item, promptId, no++, options, undoableOpener(turn) === item ? turn.turn_id : undefined));
  };

  for (const turn of turns) {
    const opener = turn.items.find(
      (item): item is UserMessageItem => item.type === 'user_message' && item.placement === 'opener',
    );
    const promptId = opener === undefined ? undefined : opener.prompt_ids[0] ?? turn.turn_id;
    const steps = new Map(turn.steps.map((step) => [step.index, step]));
    let lastAssistant: AssistantGroup | undefined;

    turn.items.forEach((item, position) => {
      const step = item.step_index === undefined ? undefined : steps.get(item.step_index);
      switch (item.type) {
        case 'user_message':
          userMessage(item, turn, promptId);
          break;
        case 'notification': {
          const opened = group === undefined;
          const g = absorb(group ?? open(item.item_id, undefined, turn, item.created_at), turn);
          if (!opened && startsRound(turn.items, position)) markFinal();
          g.blocks.push({ kind: 'notification', notification: { ...notificationOf(item), createdAt: item.created_at } });
          break;
        }
        case 'assistant_message': {
          if (item.text.length === 0) break;
          const g = assistantGroup(turn, promptId, item.item_id, item.created_at);
          const block: Extract<TurnBlock, { kind: 'text' }> = { kind: 'text', text: item.text, ...streaming(item.status), ...debugOf(item) };
          g.textParts.push(item.text);
          g.blocks.push(block);
          if (item.text.trim().length > 0) g.candidate = block;
          if (g.chat.id !== item.item_id) g.chat.endedAt = item.created_at;
          lastAssistant = g;
          break;
        }
        case 'reasoning': {
          if (item.text.length === 0) break;
          const g = assistantGroup(turn, promptId, item.item_id, item.created_at);
          g.thinkingParts.push(item.text);
          g.blocks.push({ kind: 'thinking', thinking: item.text, startedAt: item.started_at, durationMs: item.duration_ms, ...streaming(item.status), ...debugOf(item) });
          if (g.chat.id !== item.item_id) g.chat.endedAt = item.created_at;
          lastAssistant = g;
          break;
        }
        case 'tool_call': {
          const g = assistantGroup(turn, promptId, item.item_id, item.started_at);
          const tool = toolCallOf(item, options);
          g.candidate = undefined;
          g.tools.push(tool);
          g.blocks.push({ kind: 'tool', tool, ...streaming(item.status), ...debugOf(item) });
          g.chat.endedAt = item.status === 'ended' ? item.ended_at ?? step?.ended_at ?? item.started_at : item.started_at;
          lastAssistant = g;
          break;
        }
        case 'system':
          if (item.kind === 'compaction') {
            close(false);
            out.push(compactionTurn(item, no));
          }
          break;
      }
    });
    const last = lastAssistant as AssistantGroup | undefined;
    if (last !== undefined) {
      if (turn.duration_ms !== undefined) last.chat.durationMs = turn.duration_ms;
      if (turn.ended_at !== undefined) last.chat.endedAt = turn.ended_at;
    }
  }
  close(true);
  return out;
}

function streaming(status: ConversationItem['status']): { streaming?: true } {
  return status === 'running' ? { streaming: true } : {};
}

function debugOf(item: ConversationItem): { debug?: readonly ConversationRequestDebug[] } {
  return item.debug === undefined ? {} : { debug: [item.debug] };
}

function mergedDebug(a: TurnBlock, b: TurnBlock): { debug?: readonly ConversationRequestDebug[] } {
  return a.debug === undefined && b.debug === undefined ? {} : { debug: [...(a.debug ?? []), ...(b.debug ?? [])] };
}

function mergeBlocks(blocks: readonly TurnBlock[]): TurnBlock[] {
  const merged: TurnBlock[] = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (
      block.kind === 'text' &&
      last?.kind === 'text' &&
      (last.streaming === true) === (block.streaming === true) &&
      (last.final === true) === (block.final === true)
    ) {
      merged[merged.length - 1] = { ...last, text: `${last.text}\n${block.text}`, ...mergedDebug(last, block) };
    } else if (block.kind === 'thinking' && last?.kind === 'thinking' && (last.streaming === true) === (block.streaming === true)) {
      merged[merged.length - 1] = { ...mergeThinking(last, block), ...mergedDebug(last, block) };
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function mergeThinking(a: ThinkingBlock, b: ThinkingBlock): ThinkingBlock {
  const start = [a.startedAt, b.startedAt].filter((value): value is string => value !== undefined).sort()[0];
  const open = [a, b].some((part) => part.startedAt !== undefined && part.durationMs === undefined);
  const ends = [a, b].flatMap((part) =>
    part.startedAt !== undefined && part.durationMs !== undefined ? [Date.parse(part.startedAt) + part.durationMs] : [],
  );
  return {
    ...a,
    thinking: `${a.thinking}\n${b.thinking}`,
    startedAt: start,
    durationMs: !open && start !== undefined && ends.length > 0 ? Math.max(...ends) - Date.parse(start) : undefined,
  };
}

function userTurn(
  item: UserMessageItem,
  promptId: string | undefined,
  no: number,
  options: ConversationProjectionOptions,
  undoTurnId: string | undefined,
): ChatTurn {
  const origin = item.origin;
  const steered = item.placement === 'steer';
  return withAttachments(
    {
      id: item.item_id,
      clientMetadata: item.metadata === undefined ? undefined : [item.metadata],
      role: 'user',
      no,
      text: origin.kind === 'skill' || origin.kind === 'plugin_command' ? origin.args ?? '' : item.text,
      undoTurnId,
      steered: steered || undefined,
      steerPhase: steered ? (item.prompt_ids.length > 0 ? 'injected' : 'sending') : undefined,
      promptIds: steered && item.prompt_ids.length > 0 ? item.prompt_ids : promptId === undefined ? undefined : [promptId],
      skillActivation: origin.kind === 'skill' ? { name: origin.name, path: origin.path, args: origin.args } : undefined,
      skillActivations: item.skills.length > 0 ? item.skills.map(({ name, path, args }) => ({ name, path, args })) : undefined,
      pluginCommand: origin.kind === 'plugin_command'
        ? { pluginId: origin.plugin_id, commandName: origin.command, args: origin.args }
        : undefined,
      createdAt: item.created_at,
    },
    item.attachments.flatMap((attachment) => turnAttachmentOf(attachment, options)),
  );
}

function withAttachments(turn: ChatTurn, attachments: readonly TurnAttachment[]): ChatTurn {
  let mediaCount = 0;
  const ordered = attachments.map((attachment) =>
    attachment.kind === 'file' ? attachment : { ...attachment, mediaOrdinal: ++mediaCount },
  );
  const inline = inlineReferencedIndexes(turn.text);
  const fileCount = ordered.length - mediaCount;
  const filePills = [...inline.files].some((index) => index <= fileCount);
  const mediaPills = [...inline.media].some((index) => index <= mediaCount);
  let filePosition = 0;
  const kept = ordered.filter((attachment) => {
    if (attachment.kind !== 'file') return true;
    filePosition += 1;
    return !(filePills && inline.files.has(filePosition));
  });
  return {
    ...turn,
    attachments: kept.length > 0 ? kept : undefined,
    inlineAttachments: filePills || mediaPills ? ordered : undefined,
  };
}

function turnAttachmentOf(attachment: ConversationAttachment, options: ConversationProjectionOptions): TurnAttachment[] {
  const fileId = attachment.file_id;
  if (attachment.kind === 'file') {
    const url = fileId === undefined ? '' : options.getFileUrl?.(fileId) ?? '';
    return [{ kind: 'file', url, fileId, name: attachment.name, mediaType: attachment.media_type, size: attachment.size }];
  }
  if (attachment.kind === 'audio') return [];
  const url = attachment.url ?? (fileId === undefined ? undefined : options.getSessionMediaUrl?.(options.sessionId, fileId) ?? '');
  if (url === undefined) return [];
  return [{
    kind: attachment.kind,
    url,
    fileId,
    sessionId: fileId === undefined ? undefined : options.sessionId,
    name: attachment.name,
    mediaType: attachment.media_type,
  }];
}

function pendingAttachmentOf(part: AppMessageContent, sessionId: string, options: ConversationProjectionOptions): TurnAttachment[] {
  if (part.type === 'image' || part.type === 'video') {
    const source = part.source;
    switch (source.kind) {
      case 'url':
        return [{ kind: part.type, url: source.url, name: part.name }];
      case 'base64':
        return [{ kind: part.type, url: `data:${source.mediaType};base64,${source.data}`, name: part.name }];
      case 'file':
        return [{ kind: part.type, url: options.getFileUrl?.(source.fileId) ?? '', fileId: source.fileId, name: part.name }];
      case 'sessionMedia':
        return [{
          kind: part.type,
          url: options.getSessionMediaUrl?.(sessionId, source.fileId) ?? '',
          fileId: source.fileId,
          sessionId,
          name: part.name,
        }];
    }
  }
  if (part.type !== 'file') return [];
  const url = options.getFileUrl?.(part.fileId) ?? '';
  if (isModelSupportedImageMime(part.mediaType)) return [{ kind: 'image', url, fileId: part.fileId, name: part.name }];
  if (part.mediaType.startsWith('video/')) return [{ kind: 'video', url, fileId: part.fileId, name: part.name }];
  return [{ kind: 'file', url, fileId: part.fileId, name: part.name, mediaType: part.mediaType || undefined, size: part.size }];
}

function compactionTurn(item: CompactionItem, no: number): ChatTurn {
  return {
    id: item.item_id,
    role: 'compaction',
    no,
    text: item.summary ?? '',
    compaction: { trigger: item.trigger, tokensBefore: item.tokens_before, tokensAfter: item.tokens_after },
  };
}

function toolCallOf(item: ToolCallItem, options: ConversationProjectionOptions): ToolCall {
  const cached = toolCalls.get(item);
  if (cached?.sessionId === options.sessionId) return cached.tool;
  const ended = item.status === 'ended';
  const completed = item.outcome === 'completed';
  const result = ended ? (completed ? item.output : item.error ?? item.output) ?? '' : undefined;
  const output = normalizeToolOutput(ended ? result : item.output);
  const refs = item.agent_refs;
  const input = item.input ?? (item.stage === 'input' ? item.input_text : undefined) ?? item.display ?? {};
  const plan = item.name === 'ExitPlanMode' ? planOf(item) : undefined;
  const tool: ToolCall = {
    id: item.item_id,
    name: item.name,
    arg: typeof input === 'string' ? input : JSON.stringify(input),
    mcpAuth: mcpAuthCardOf(item),
    status: !ended ? 'running' : item.outcome === 'failed' ? 'error' : item.outcome === 'interrupted' ? 'cancelled' : 'ok',
    agentId:
      (normalizeToolName(item.name) === 'task' ? (refs?.find((ref) => ref.role !== 'member') ?? refs?.[0])?.agent_id : undefined) ??
      agentIdFromOutput(item.name, output),
    startedAt: isNotifyUserTool(item.name) ? item.started_at : undefined,
    output,
    resultText: ended ? toolResultText(result) : undefined,
    media: ended && completed
      ? normalizeToolMedia(item.name, result, options.sessionId, options.getSessionMediaUrl) ??
        withReadMediaDetails(item.name, toolMediaOf(item.media?.[0], options), item.output ?? '', item.note)
      : undefined,
    plan,
    planPath: plan?.path ?? (item.name === 'ExitPlanMode' && ended ? parsePlanSavedPath(output) : undefined),
  };
  toolCalls.set(item, { sessionId: options.sessionId, tool });
  return tool;
}

function startsRound(items: readonly ConversationItem[], position: number): boolean {
  const before = nearestStepIndex(items, position, -1);
  return before === undefined || before !== nearestStepIndex(items, position, 1);
}

function nearestStepIndex(items: readonly ConversationItem[], position: number, direction: 1 | -1): number | undefined {
  for (let index = position + direction; index >= 0 && index < items.length; index += direction) {
    const stepIndex = items[index]!.step_index;
    if (stepIndex !== undefined) return stepIndex;
  }
  return undefined;
}

function notificationOf(item: NotificationItem): TaskNotification {
  const output = item.output;
  return {
    id: item.notification_id,
    type: item.notification_type,
    sourceKind: item.source.kind,
    sourceId: item.source.id,
    agentId: item.agent_id,
    title: item.title,
    severity: item.severity,
    body: item.body,
    outputFile: output?.file === undefined ? undefined : { path: output.file, bytes: output.bytes },
    outputPreview: output?.preview === undefined
      ? undefined
      : { text: output.preview, bytes: output.bytes, truncated: output.truncated },
    questionAnswer: item.answer === undefined ? undefined : { answers: { ...item.answer.answers }, note: item.answer.note ?? '' },
    raw: JSON.stringify(item, null, 2),
  };
}

function toolMediaOf(media: ConversationMedia | undefined, options: ConversationProjectionOptions): ToolMedia | undefined {
  if (media === undefined) return undefined;
  const url = media.url ?? (media.file_id === undefined ? undefined : options.getSessionMediaUrl?.(options.sessionId, media.file_id));
  if (url === undefined) return undefined;
  return {
    kind: media.kind,
    url,
    mimeType: media.media_type,
    fileId: media.file_id,
    sessionId: media.file_id === undefined ? undefined : options.sessionId,
  };
}

function planOf(item: ToolCallItem): SessionPlan | undefined {
  const display = item.display as PlanReviewDisplay | undefined;
  if (display?.kind !== 'plan_review') return undefined;
  return {
    toolCallId: item.item_id,
    plan: display.plan,
    path: display.path,
    review: {
      state: display.review.state,
      selectedOption: display.review.selected_option,
      feedback: display.review.feedback,
    },
  };
}
