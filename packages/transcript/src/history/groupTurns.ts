/**
 * Cold-path history grouping: rebuild a turn tree from a flat message list
 * (as produced by the engine's `reduceContextTranscript`).
 *
 * This is a best-effort reconstruction — the live path (engine events) is the
 * high-fidelity one. Known limitations, accepted by design:
 *  - step granularity collapses to "one assistant message = one step";
 *  - live-only detail is never backfilled: step usage / finishReason /
 *    timing / retry, turn durationMs / error, tool inputText / progress, and
 *    task resultSummary / error / stateReason / usage exist only on live
 *    engine events — persisted context messages do not carry them;
 *  - media content parts become attachment entities (metadata only — base64
 *    bytes are dropped, never shipped); mid-turn media is not anchored;
 *  - streamed-vs-persisted duplication is assumed already resolved upstream;
 *  - only the turn tree is built here: tasks / interactions / todos / meta
 *    (goal, plan, swarm) are NOT context messages — the companion fold
 *    (`foldWireRecordFacts` in `foldFacts.ts`) rebuilds them from the
 *    non-`context.*` wire records on top of this base snapshot;
 *  - persisted messages carry no turn ids, so turn ordinals are assigned by
 *    grouping — **0-based, matching the engine's live turn numbering** — and
 *    can drift from the engine's ids when hidden origins (e.g. retries) make
 *    the engine consume an ordinal that grouping cannot see. Alignment is
 *    what makes a rebuilt slice safe to merge into a live store (backfill):
 *    the engine's next turn continues at `t<turnCount>` without colliding.
 *
 * The input type is structural so the engine's `ContextMessage` is directly
 * assignable without a dependency from this package onto the engine.
 */

import type { AgentTranscriptSnapshot } from '../ops/operation';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { TranscriptItem, TranscriptMarker } from '../model/item';
import type { TurnOrigin } from '../model/turn';

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

/** Origins whose content is context, not display — folded away, not shown. */
const HIDDEN_USER_ORIGINS = new Set(['injection', 'system_trigger', 'retry']);
/**
 * Hidden origins that nonetheless OPEN a real engine turn
 * (`MessageStepRequest` with `admission: 'newTurn'`, e.g. goal continuation;
 * a subagent's run prompt goes through `promptService.enqueue`, which always
 * launches a new turn). Other hidden origins are mid-turn context
 * (reminders, injections, retries) and stay folded away; skipping a
 * turn-opening one would fold the continuation's assistant output into the
 * prior visible turn and break the 0-based ordinal alignment with the
 * engine's live turn numbering.
 */
const TURN_OPENING_SYSTEM_TRIGGERS = new Set(['goal_continuation', 'subagent']);
/** Origins rendered as timeline markers rather than turns. */
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
  /** Next turn ordinal — 0-based, matching the engine's live turn numbering. */
  let nextOrdinal = 0;
  let markerCount = 0;

  /** Media parts of a turn-opening user message → attachment entities (+ ids). */
  const collectAttachments = (message: HistoryMessage): string[] | undefined => {
    const ids: string[] = [];
    for (const part of message.content ?? []) {
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
          // base64 bytes are deliberately dropped — never shipped to clients.
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
      } else if (part.type === 'file' && 'file_id' in part) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: part.media_type as string,
          name: part.name as string,
          size: part.size as number,
          source: { kind: 'file', fileId: part.file_id as string },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
      }
    }
    return ids.length > 0 ? ids : undefined;
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
          // A real turn boundary: advance the grouping (and the ordinal).
          // The steering text is internal — the boundary lands promptless,
          // mirroring the live path's displayable-origin gate.
          startTurn(mapOrigin(message));
        }
        continue;
      }
      const markerKey = originKind !== undefined ? MARKER_USER_ORIGINS[originKind] : undefined;
      if (markerKey !== undefined) {
        pushMarker(markerKey, { text: textOf(message), origin: message.origin });
        // A user-slash skill/plugin command is a real user prompt (mirrors
        // the engine's `isRealUserPrompt`): it opened its own turn, so
        // advance the grouping instead of folding the response into the
        // previous turn. Other triggers are mid-turn context — marker only.
        if (isUserSlashPrompt(message)) {
          startTurn(mapOrigin(message), textOf(message));
        }
        continue;
      }
      startTurn(mapOrigin(message), textOf(message), collectAttachments(message));
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
          // The result may not be persisted yet (approval pending / tool
          // still executing at capture time): start 'running' and let the
          // `role === 'tool'` branch transition to done/error.
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

  // The entity slots stay empty here: tasks / interactions / todos / meta are
  // not context messages — `foldWireRecordFacts` fills them from the
  // non-`context.*` wire records on top of this base snapshot. Prompts stay
  // empty too: the wire journal carries no prompt records (see foldFacts).
  return { items, tasks: [], interactions: [], attachments, todos: [], prompts: [], meta: {} };
}

// ---------------------------------------------------------------- helpers

/** Whether a hidden-origin user message opened its own engine turn. */
function opensOwnTurn(message: HistoryMessage): boolean {
  const origin = message.origin as { kind?: unknown; name?: unknown } | undefined;
  return (
    origin?.kind === 'system_trigger' &&
    typeof origin.name === 'string' &&
    TURN_OPENING_SYSTEM_TRIGGERS.has(origin.name)
  );
}

/**
 * Whether a skill/plugin-activation message was a user-slash prompt — a real
 * turn opener per the engine's `isRealUserPrompt` (other triggers are
 * mid-turn context).
 */
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
      // Legacy/v1 sessions persist background-task notifications under the
      // 'background_task' spelling (the live mapper already handles it) —
      // same shape, same taskId, so the turn keeps its task link.
      const taskId = (origin as { taskId?: unknown }).taskId;
      return taskId !== undefined && typeof taskId === 'string'
        ? { kind: 'task', taskId, payload: origin }
        : { kind: 'other', payload: origin };
    }
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'shell_command':
      // `!shell` input/output echo: displayed as user-turn input; the payload
      // (`phase`, `isError`) lets a client renderer specialize later.
      return { kind: 'user', payload: origin };
    case 'user':
    case undefined:
      return { kind: 'user' };
    default:
      return { kind: 'other', payload: origin };
  }
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

/** Re-project the (mutated) draft into the items array, preserving identity of slots. */
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
