/**
 * `contextMemory` domain (L4) — wire Model (`ContextModel`) and the wire-protocol
 * 1.4 Ops `context.append_message` (`contextAppendMessage`) / `context.clear`
 * (`contextClear`) / `context.apply_compaction` (`contextApplyCompaction`) /
 * `context.undo` (`contextUndo`) for the per-agent conversation history, plus the
 * legacy `context.splice` (`contextSplice`) Op.
 *
 * Declares the history as `ContextMessage[]` (initial `[]`); every Op's `apply`
 * is a pure array transform that returns a NEW reference on change and the SAME
 * reference on a no-op (so the wire's reference-equality gate stays quiet), and
 * carries no non-determinism — message ids are stamped at the dispatch call site
 * (`AgentContextMemoryService.append`), never inside `apply`.
 *
 * The live write path emits the 1.4 Ops (`append_message` / `clear` /
 * `apply_compaction` / `undo`); assistant and tool messages are persisted already
 * folded (the loop appends whole messages, not raw loop events), so on-disk
 * records use the 1.4 type names. Sessions written by the v1 loop stream a turn
 * as `context.append_loop_event` records instead; `contextAppendLoopEvent` folds
 * them back into assistant / tool messages at restore time (see
 * `loopEventFold.ts`) so those sessions replay identically. `context.splice` (the
 * pre-1.4 primitive) stays registered so sessions written at wire protocol 1.5
 * still replay (newer-version passthrough, no migration) and for the few internal
 * single-delete mutations that have no 1.4 spelling.
 *
 * Blob handling is declared as a `ModelBlobCodec` on `ContextModel.blobs`:
 * - `dehydrate(record, transform)`: at dispatch time, traverses message content
 *   in `context.splice` and `context.append_message` records, passing each
 *   `ContentPart[]` through `transform` to offload oversized data URIs.
 * - `rehydrate(state, transform)`: after replay, traverses the surviving final
 *   state and loads `blobref:` URLs back to inline data — skipping I/O for
 *   data that was compacted away during the session.
 */

import type { ContentPart } from '#/app/llmProtocol';
import { defineModel, defineOp, type PartsTransformer } from '#/wire';
import type { PersistedRecord } from '#/wire';

import {
  foldAppendMessage,
  foldLoopEvent,
  resetFold,
  type LoopRecordedEvent,
} from './loopEventFold';
import type { ContextMessage } from './types';

async function dehydrateMessages(
  messages: readonly ContextMessage[],
  transform: PartsTransformer,
): Promise<{ changed: boolean; result: ContextMessage[] }> {
  let changed = false;
  const result: ContextMessage[] = [];
  for (const msg of messages) {
    const parts = await transform(msg.content);
    if (parts !== msg.content) {
      changed = true;
      result.push({ ...msg, content: [...parts] as ContentPart[] });
    } else {
      result.push(msg);
    }
  }
  return { changed, result };
}

async function dehydrateRecord(
  record: PersistedRecord,
  transform: PartsTransformer,
): Promise<PersistedRecord> {
  if (record.type === 'context.splice') {
    const messages = record['messages'];
    if (!Array.isArray(messages)) return record;
    const { changed, result } = await dehydrateMessages(messages as ContextMessage[], transform);
    return changed ? { ...record, messages: result } : record;
  }
  if (record.type === 'context.append_message') {
    const message = record['message'] as ContextMessage | undefined;
    if (message === undefined) return record;
    const parts = await transform(message.content);
    if (parts === message.content) return record;
    return { ...record, message: { ...message, content: [...parts] } };
  }
  return record;
}

export const ContextModel = defineModel<ContextMessage[]>('contextMemory', () => [], {
  blobs: {
    dehydrate: dehydrateRecord,
    rehydrate: async (state, transform) => {
      const { changed, result } = await dehydrateMessages(state, transform);
      return changed ? result : state;
    },
  },
});

export interface ContextSplicePayload {
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
  readonly tokens?: number;
}

/** @deprecated Legacy 1.5 record type; kept for replay of old sessions and rare internal single-deletes. */
export const contextSplice = defineOp(ContextModel, 'context.splice', {
  apply: (state, p: ContextSplicePayload): ContextMessage[] => {
    if (p.deleteCount === 0 && p.messages.length === 0) return state;
    const next = state.slice();
    next.splice(p.start, p.deleteCount, ...p.messages);
    return resetFold(next) as ContextMessage[];
  },
});

export interface ContextMessagePayload {
  readonly message: ContextMessage;
}

export const contextAppendMessage = defineOp(ContextModel, 'context.append_message', {
  apply: (state, p: ContextMessagePayload): ContextMessage[] =>
    foldAppendMessage(state, p.message) as ContextMessage[],
});

export interface ContextLoopEventPayload {
  readonly event: LoopRecordedEvent;
}

/**
 * Restore-only Op: folds a v1 `context.append_loop_event` record into the
 * history (see `loopEventFold.ts`). Never dispatched by the v2 live loop, so it
 * is never persisted by v2 — registering it lets `WireService.replay` reduce
 * v1-loop sessions instead of skipping the record.
 */
export const contextAppendLoopEvent = defineOp(ContextModel, 'context.append_loop_event', {
  apply: (state, p: ContextLoopEventPayload): ContextMessage[] =>
    foldLoopEvent(state, p.event) as ContextMessage[],
});

export const contextClear = defineOp(ContextModel, 'context.clear', {
  apply: (state): ContextMessage[] => (state.length === 0 ? state : resetFold([]) as ContextMessage[]),
});

export interface ContextCompactionPayload {
  readonly count: number;
  readonly summary: ContextMessage;
}

export const contextApplyCompaction = defineOp(ContextModel, 'context.apply_compaction', {
  apply: (state, p: ContextCompactionPayload): ContextMessage[] =>
    resetFold([p.summary, ...state.slice(p.count)]) as ContextMessage[],
});

export interface ContextUndoPayload {
  readonly count: number;
}

export interface UndoCut {
  readonly cutIndex: number;
  readonly removedCount: number;
  readonly stoppedAtCompaction: boolean;
}

/**
 * Locate the trailing cut for an undo of `count` real-user prompts: the oldest
 * index of the Nth-from-tail real-user prompt (skipping `injection` messages and
 * stopping at a `compaction_summary` boundary). `removedCount` is how many
 * real-user prompts were found; `cutIndex` is where the trailing exchange begins
 * (everything from there to the end is removed), or `-1` when none was found.
 * Shared by the `context.undo` reducer and the live service so dispatch and
 * replay produce identical state.
 */
export function computeUndoCut(state: readonly ContextMessage[], count: number): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let removedCount = 0;
  let stoppedAtCompaction = false;
  for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
    const message = state[i];
    if (message === undefined || message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isRealUserPrompt(message)) {
      remaining--;
      removedCount++;
      cutIndex = i;
    }
  }
  return { cutIndex, removedCount, stoppedAtCompaction };
}

export const contextUndo = defineOp(ContextModel, 'context.undo', {
  apply: (state, p: ContextUndoPayload): ContextMessage[] => {
    if (p.count <= 0 || state.length === 0) return state;
    const { cutIndex, removedCount } = computeUndoCut(state, p.count);
    if (cutIndex < 0 || removedCount < p.count) return state;
    return resetFold(state.slice(0, cutIndex)) as ContextMessage[];
  },
});

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}
