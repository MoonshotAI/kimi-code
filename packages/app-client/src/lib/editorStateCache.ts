// packages/app-client/src/lib/editorStateCache.ts
// Per-session stash for composer ProseMirror EditorStates. An EditorState is
// self-contained (doc + selection + the history plugin's undo/redo stacks),
// so keeping one per session id gives each session its own undo history when
// the user switches between chats. In-memory only by design: app restart
// clears it (the persisted draft stays the source of truth for text).
//
// The cache lives at module level so it survives composer unmount/remount
// (the empty-session and docked composers are separate component instances).
// DOM-free (prosemirror-state only) — safe to import from node-env tests.
import type { EditorState } from 'prosemirror-state';

/** Bound on stashed sessions; least-recently-stashed entries are evicted. */
const MAX_STASHED_STATES = 50;

const stashed = new Map<string, EditorState>();

/** Stash (or refresh) the state for a session. Re-stashing bumps recency. */
export function stashEditorState(sessionId: string, state: EditorState): void {
  stashed.delete(sessionId);
  stashed.set(sessionId, state);
  while (stashed.size > MAX_STASHED_STATES) {
    const oldest = stashed.keys().next().value;
    if (oldest === undefined) break;
    stashed.delete(oldest);
  }
}

/** Take the stashed state for a session (move semantics — the entry is
 *  removed; the live editor owns it now). Undefined when nothing is stashed. */
export function takeEditorState(sessionId: string): EditorState | undefined {
  const state = stashed.get(sessionId);
  if (state !== undefined) stashed.delete(sessionId);
  return state;
}

/** Drop everything — exposed for tests. */
export function clearStashedEditorStates(): void {
  stashed.clear();
}
