/**
 * `contextMemory` domain (L4) — wire Model (`ContextModel`) and the
 * `context.splice` (`contextSplice`) / `context.append_message`
 * (`contextAppendMessage`) / `context.append_loop_event`
 * (`contextAppendLoopEvent`) / `context.clear` (`contextClear`) /
 * `context.apply_compaction` (`contextApplyCompaction`) / `context.undo`
 * (`contextUndo`) Ops for the per-agent conversation history, plus the
 * `contextBlobSelector` that drives blob offload for `context.splice` records.
 *
 * Declares the history as `ContextMessage[]` (initial `[]`); every Op's `apply`
 * is a pure array transform that returns a NEW reference on change and the SAME
 * reference on a no-op (so the wire's reference-equality gate stays quiet), and
 * carries no non-determinism — message ids are stamped at the dispatch call site
 * (`AgentContextMemoryService.splice`), never inside `apply`. The higher-level
 * legacy record types (`append_message` / `append_loop_event` / `clear` /
 * `apply_compaction` / `undo`) are declared for wire-schema coverage and tested
 * directly; the live service writes only `context.splice` (splice is the single
 * primitive the other shapes fold into).
 *
 * Blob handling uses two complementary mechanisms:
 * - `contextBlobSelector` (record-level): offloads oversized content parts to
 *   blob storage on append, replacing data URIs with `blobref:` references.
 * - `ContextModel.rehydrate` (model-level): after replay, traverses the
 *   surviving final state and rehydrates `blobref:` URLs back to inline data
 *   URIs — skipping I/O for data that was compacted away during the session.
 *
 * The selector is seeded into the Agent wire by `agentLifecycle`.
 */

import type { ContentPart } from '#/app/llmProtocol';
import { defineModel, defineOp, type WireBlobSelector } from '#/wire';

import type { ContextMessage } from './types';

export const ContextModel = defineModel<ContextMessage[]>('contextMemory', () => [], {
  rehydrate: async (state, rehydrateParts) => {
    let changed = false;
    const result: ContextMessage[] = [];
    for (const msg of state) {
      const parts = await rehydrateParts(msg.content);
      if (parts !== msg.content) {
        changed = true;
        result.push({ ...msg, content: [...parts] as ContentPart[] });
      } else {
        result.push(msg);
      }
    }
    return changed ? result : state;
  },
});

export interface ContextSplicePayload {
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
  readonly tokens?: number;
}

export const contextSplice = defineOp(ContextModel, 'context.splice', {
  apply: (state, p: ContextSplicePayload): ContextMessage[] => {
    if (p.deleteCount === 0 && p.messages.length === 0) return state;
    const next = state.slice();
    next.splice(p.start, p.deleteCount, ...p.messages);
    return next;
  },
});

export interface ContextMessagePayload {
  readonly message: ContextMessage;
}

export const contextAppendMessage = defineOp(ContextModel, 'context.append_message', {
  apply: (state, p: ContextMessagePayload): ContextMessage[] => [...state, p.message],
});

export const contextAppendLoopEvent = defineOp(ContextModel, 'context.append_loop_event', {
  apply: (state, p: ContextMessagePayload): ContextMessage[] => [...state, p.message],
});

export const contextClear = defineOp(ContextModel, 'context.clear', {
  apply: (state): ContextMessage[] => (state.length === 0 ? state : []),
});

export interface ContextCompactionPayload {
  readonly count: number;
  readonly summary: ContextMessage;
}

export const contextApplyCompaction = defineOp(ContextModel, 'context.apply_compaction', {
  apply: (state, p: ContextCompactionPayload): ContextMessage[] => [
    p.summary,
    ...state.slice(p.count),
  ],
});

export interface ContextUndoPayload {
  readonly count: number;
}

export const contextUndo = defineOp(ContextModel, 'context.undo', {
  apply: (state, p: ContextUndoPayload): ContextMessage[] => {
    if (p.count <= 0 || state.length === 0) return state;
    const drop = new Set<number>();
    let remaining = p.count;
    for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
      if (state[i]!.role !== 'user') continue;
      drop.add(i);
      remaining--;
    }
    if (drop.size === 0) return state;
    return state.filter((_, index) => !drop.has(index));
  },
});

export const contextBlobSelector: WireBlobSelector = (record) => {
  if (record.type !== 'context.splice') return [];
  const messages = record['messages'];
  if (!Array.isArray(messages)) return [];
  return (messages as readonly ContextMessage[]).map((message, index) => ({
    parts: message.content,
    replace: (current, parts) => ({
      ...current,
      messages: (current['messages'] as readonly ContextMessage[]).map((item, itemIndex) =>
        itemIndex === index ? { ...item, content: [...parts] } : item,
      ),
    }),
  }));
};
