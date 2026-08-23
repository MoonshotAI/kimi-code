import type { AgentTranscriptSnapshot } from '../ops/operation';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { TranscriptItem, TranscriptMarker } from '../model/item';
import type { TurnOrigin } from '../model/turn';
import { daemonFileRefFromPairingPart } from '../contract/mediaRef';

export type HistoryMediaSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'base64'; readonly media_type: string; readonly data: string }
  | { readonly kind: 'file'; readonly file_id: string };

export type HistoryContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'think'; readonly think: string }
  | { readonly type: 'image' | 'video' | 'audio'; readonly source: HistoryMediaSource }
  | {
      readonly type: 'file';
      readonly file_id: string;
      readonly name: string;
      readonly media_type: string;
      readonly size: number;
    }
  | { readonly type: string };

export interface HistoryToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string | null;
}

export interface HistoryMessage {
  readonly role: string;
  readonly content?: readonly HistoryContentPart[];
  readonly toolCalls?: readonly HistoryToolCall[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly origin?: { readonly kind: string };
}

interface TurnDraft {
  turnId: string;
  ordinal: number;
  origin: TurnOrigin;
  prompt?: string;
  attachmentIds?: string[];
  steps: StepDraft[];
}

interface StepDraft {
  stepId: string;
  ordinal: number;
  frames: TranscriptFrame[];
}

const HIDDEN_USER_ORIGINS = new Set(['injection', 'system_trigger', 'retry']);
const TURN_OPENING_SYSTEM_TRIGGERS = new Set(['goal_continuation', 'subagent']);
const MARKER_USER_ORIGINS: Readonly<Record<string, string>> = {
  skill_activation: 'skill',
  plugin_command: 'skill',
  compaction_summary: 'compaction',
};

const FALLBACK_ORIGIN: TurnOrigin = { kind: 'other' };

export function groupMessagesIntoSnapshot(
  messages: readonly HistoryMessage[],
): AgentTranscriptSnapshot {
  const items: TranscriptItem[] = [];
  const attachments: TranscriptAttachment[] = [];
  let turn: TurnDraft | undefined;
  let nextOrdinal = 0;
  let markerCount = 0;

  const foldTurnOpeningInput = (
    message: HistoryMessage,
  ): { text: string; attachmentIds?: string[] } => {
    const parts = message.content ?? [];
    const ids: string[] = [];
    const texts: string[] = [];
    for (const part of parts) {
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        texts.push(part.text);
        continue;
      }
      if (part.type === 'image' || part.type === 'video' || part.type === 'audio') {
        if (!('source' in part) || part.source === undefined) continue;
        const source = part.source as HistoryMediaSource;
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType:
            source.kind === 'base64' ? source.media_type : `${part.type}/*`,
          source:
            source.kind === 'url'
              ? { kind: 'url', url: source.url }
              : source.kind === 'file'
                ? { kind: 'file', fileId: source.file_id }
                : undefined,
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
        continue;
      }
      if (part.type === 'file' && 'file_id' in part) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: part.media_type as string,
          name: part.name as string,
          size: part.size as number,
          source: { kind: 'file', fileId: part.file_id as string },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
        continue;
      }
      const ref = daemonFileRefFromPairingPart(part);
      if (ref !== undefined) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: `${ref.kind}/*`,
          source: { kind: 'session_media', fileId: ref.ref.fileId },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
      }
    }
    return { text: texts.join(''), attachmentIds: ids.length > 0 ? ids : undefined };
  };

  const ensureTurn = (origin: TurnOrigin = FALLBACK_ORIGIN): TurnDraft => {
    if (!turn) {
      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      turn = { turnId: `t${ordinal}`, ordinal, origin, steps: [] };
      items.push(draftToTurnItem(turn));
    }
    return turn;
  };

  const startTurn = (origin: TurnOrigin, prompt?: string, attachmentIds?: string[]): TurnDraft => {
    const ordinal = nextOrdinal;
    nextOrdinal += 1;
    turn = { turnId: `t${ordinal}`, ordinal, origin, prompt, attachmentIds, steps: [] };
    items.push(draftToTurnItem(turn));
    return turn;
  };

  const pushMarker = (marker: string, payload?: unknown): void => {
    markerCount += 1;
    const item: TranscriptMarker = { kind: 'marker', markerId: `m${markerCount}`, marker, payload };
    items.push(item);
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    const originKind = message.origin?.kind;

    if (message.role === 'user') {
      if (originKind !== undefined && HIDDEN_USER_ORIGINS.has(originKind)) {
        if (opensOwnTurn(message)) {
          startTurn(mapOrigin(message));
        }
        continue;
      }
      const markerKey = originKind !== undefined ? MARKER_USER_ORIGINS[originKind] : undefined;
      if (markerKey !== undefined) {
        const opening = isUserSlashPrompt(message) ? foldTurnOpeningInput(message) : undefined;
        pushMarker(markerKey, { text: opening?.text ?? textOf(message), origin: message.origin });
        if (opening !== undefined) {
          startTurn(mapOrigin(message), opening.text, opening.attachmentIds);
        }
        continue;
      }
      const bundled = bundledSkillActivations(message);
      if (bundled.length > 0) {
        const parts = message.content ?? [];
        bundled.forEach((activation, index) => {
          const block = parts[index];
          pushMarker('skill', {
            text: block !== undefined && block.type === 'text' && 'text' in block ? block.text : '',
            origin: { kind: 'skill_activation', trigger: 'user-slash', ...activation },
          });
        });
        const callerMessage = { ...message, content: parts.slice(bundled.length) };
        const opening = foldTurnOpeningInput(callerMessage);
        startTurn(mapOrigin(message), opening.text, opening.attachmentIds);
        continue;
      }
      const opening = foldTurnOpeningInput(message);
      startTurn(mapOrigin(message), opening.text, opening.attachmentIds);
      continue;
    }

    if (message.role === 'assistant') {
      const current = ensureTurn();
      const stepOrdinal = current.steps.length + 1;
      const step: StepDraft = {
        stepId: `${current.turnId}.${stepOrdinal}`,
        ordinal: stepOrdinal,
        frames: [],
      };
      current.steps.push(step);
      let frameCount = 0;
      const nextFrameId = (): string => {
        frameCount += 1;
        return `${step.stepId}.f${frameCount}`;
      };
      for (const part of message.content ?? []) {
        if (part.type === 'text' && 'text' in part && typeof part.text === 'string' && part.text.length > 0) {
          step.frames.push({ kind: 'text', frameId: nextFrameId(), role: 'assistant', text: part.text });
        } else if (part.type === 'think' && 'think' in part && typeof part.think === 'string' && part.think.length > 0) {
          step.frames.push({ kind: 'thinking', frameId: nextFrameId(), text: part.think });
        }
      }
      for (const call of message.toolCalls ?? []) {
        step.frames.push({
          kind: 'tool',
          frameId: `${step.stepId}.${call.id}`,
          toolCallId: call.id,
          name: call.name,
          state: 'running',
          input: parseArguments(call.arguments),
        });
      }
      syncTurnItem(items, current);
      continue;
    }

    if (message.role === 'tool') {
      const frame = currentTurnToolFrame(turn, message.toolCallId);
      if (frame && frame.kind === 'tool') {
        const output = textOf(message);
        const patched: TranscriptFrame = {
          ...frame,
          state: message.isError ? 'error' : 'done',
          output,
          error: message.isError ? output : undefined,
        };
        replaceToolFrame(turn!, message.toolCallId!, patched);
        syncTurnItem(items, turn!);
      }
    }
  }

  return { items, tasks: [], interactions: [], attachments, todos: [], prompts: [], meta: {} };
}

function opensOwnTurn(message: HistoryMessage): boolean {
  const origin = message.origin as { kind?: unknown; name?: unknown } | undefined;
  return (
    origin?.kind === 'system_trigger' &&
    typeof origin.name === 'string' &&
    TURN_OPENING_SYSTEM_TRIGGERS.has(origin.name)
  );
}

function isUserSlashPrompt(message: HistoryMessage): boolean {
  const origin = message.origin as { kind?: unknown; trigger?: unknown } | undefined;
  return (
    (origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function mapOrigin(message: HistoryMessage): TurnOrigin {
  const origin = message.origin;
  switch (origin?.kind) {
    case 'cron_job':
    case 'cron_missed': {
      const jobId = (origin as { jobId?: unknown }).jobId;
      return { kind: 'cron', taskId: typeof jobId === 'string' ? jobId : undefined, payload: origin };
    }
    case 'task':
    case 'background_task': {
      const taskId = (origin as { taskId?: unknown }).taskId;
      return taskId !== undefined && typeof taskId === 'string'
        ? { kind: 'task', taskId, payload: origin }
        : { kind: 'other', payload: origin };
    }
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'shell_command':
      return { kind: 'user', payload: origin };
    case 'user':
    case undefined:
      return { kind: 'user' };
    default:
      return { kind: 'other', payload: origin };
  }
}

interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: string;
}

function bundledSkillActivations(message: HistoryMessage): readonly BundledSkillActivation[] {
  if (message.origin?.kind !== 'user') return [];
  const activations = (message.origin as { readonly skillActivations?: unknown }).skillActivations;
  if (!Array.isArray(activations)) return [];
  return activations.filter(
    (activation): activation is BundledSkillActivation =>
      typeof activation === 'object' &&
      activation !== null &&
      typeof (activation as { activationId?: unknown }).activationId === 'string' &&
      typeof (activation as { skillName?: unknown }).skillName === 'string',
  );
}

function textOf(message: HistoryMessage): string {
  return (message.content ?? [])
    .filter((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text' && 'text' in part)
    .map((part) => part.text)
    .join('');
}

function parseArguments(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function draftToTurnItem(draft: TurnDraft): TranscriptItem {
  return {
    kind: 'turn',
    turnId: draft.turnId,
    ordinal: draft.ordinal,
    state: 'completed',
    origin: draft.origin,
    prompt: draft.prompt,
    attachmentIds: draft.attachmentIds,
    steps: draft.steps.map((step) => ({
      kind: 'step' as const,
      stepId: step.stepId,
      turnId: draft.turnId,
      ordinal: step.ordinal,
      state: 'completed' as const,
      frames: step.frames,
    })),
  };
}

function syncTurnItem(items: TranscriptItem[], draft: TurnDraft): void {
  const index = items.findIndex((entry) => entry.kind === 'turn' && entry.turnId === draft.turnId);
  if (index >= 0) items[index] = draftToTurnItem(draft);
}

function currentTurnToolFrame(turn: TurnDraft | undefined, toolCallId: string | undefined): TranscriptFrame | undefined {
  if (!turn || toolCallId === undefined) return undefined;
  for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
    const frames = turn.steps[s]?.frames ?? [];
    for (let f = frames.length - 1; f >= 0; f -= 1) {
      const frame = frames[f];
      if (frame?.kind === 'tool' && frame.toolCallId === toolCallId) return frame;
    }
  }
  return undefined;
}

function replaceToolFrame(turn: TurnDraft, toolCallId: string, next: TranscriptFrame): void {
  for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
    const step = turn.steps[s];
    if (!step) continue;
    const index = step.frames.findIndex((frame) => frame.kind === 'tool' && frame.toolCallId === toolCallId);
    if (index >= 0) {
      step.frames[index] = next;
      return;
    }
  }
}
