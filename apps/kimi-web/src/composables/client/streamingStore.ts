// apps/kimi-web/src/composables/client/streamingStore.ts
//
// Fine-grained streaming-text store, kept OUTSIDE `rawState` on purpose.
//
// `assistantDelta` is the only genuinely high-frequency event (dozens to
// hundreds per second). Routing it through the immutable reducer + the coarse
// `rawState` graph makes every delta re-render the whole App and recompute the
// sidebar computeds (see the main-thread-jank investigation). Instead, deltas
// append here and only the single `StreamingBlocks` component subscribed to a
// session re-renders.
//
// Lifecycle: deltas append; `messageUpdated` (authoritative full content) and
// turn-end (`sessionStatusChanged` idle/aborted) clear the entry so the
// committed content in `messagesBySession` takes over without duplication.

import { reactive } from 'vue';

export interface StreamingBlock {
  contentIndex: number;
  kind: 'text' | 'thinking';
  text: string;
}

export interface StreamingState {
  /** id of the assistant message currently being streamed. */
  messageId: string;
  /** Ordered live text/thinking blocks (always trailing in the message). */
  blocks: StreamingBlock[];
}

/**
 * Per-session live streaming state. A session has at most one in-flight
 * assistant message (its trailing one), so a single entry per session suffices.
 */
export const streamingBySession = reactive<Record<string, StreamingState>>({});

/**
 * Append one `assistantDelta` to the streaming store. O(1): either mutates the
 * trailing block's text in place (same contentIndex) or pushes a new block
 * (new contentIndex, rare). Never touches `rawState`, so no heavy computed
 * (`turns`, sidebar) is dirtied.
 */
export function appendStreamingDelta(
  sessionId: string,
  messageId: string,
  contentIndex: number,
  delta: { text?: string; thinking?: string },
): void {
  let state = streamingBySession[sessionId];
  // A new assistant message (new step, or text resuming after a tool) starts a
  // fresh entry — the previous message is already committed via messageUpdated.
  if (!state || state.messageId !== messageId) {
    state = streamingBySession[sessionId] = { messageId, blocks: [] };
  }

  const kind: 'text' | 'thinking' = delta.text !== undefined ? 'text' : 'thinking';
  const chunk = delta.text ?? delta.thinking ?? '';
  if (chunk.length === 0) return;

  const last = state.blocks.at(-1);
  if (last && last.contentIndex === contentIndex && last.kind === kind) {
    last.text += chunk;
  } else {
    state.blocks.push({ contentIndex, kind, text: chunk });
  }
}

/** Drop the live entry for a session (commit or turn end). */
export function clearStreaming(sessionId: string): void {
  delete streamingBySession[sessionId];
}
