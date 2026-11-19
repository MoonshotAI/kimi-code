import type { EditorState } from 'prosemirror-state';

const MAX_STASHED_STATES = 50;

const stashed = new Map<string, EditorState>();

type StashedStateDroppedListener = (sessionId: string, state: EditorState) => void;

const stateDroppedListeners = new Set<StashedStateDroppedListener>();

export function onStashedStateDropped(listener: StashedStateDroppedListener): () => void {
  stateDroppedListeners.add(listener);
  return () => stateDroppedListeners.delete(listener);
}

function notifyStateDropped(sessionId: string, state: EditorState): void {
  for (const listener of stateDroppedListeners) listener(sessionId, state);
}

export function stashEditorState(sessionId: string, state: EditorState): void {
  stashed.delete(sessionId);
  stashed.set(sessionId, state);
  while (stashed.size > MAX_STASHED_STATES) {
    const oldest = stashed.keys().next().value;
    if (oldest === undefined) break;
    const evicted = stashed.get(oldest);
    stashed.delete(oldest);
    if (evicted !== undefined) notifyStateDropped(oldest, evicted);
  }
}

export function takeEditorState(sessionId: string): EditorState | undefined {
  const state = stashed.get(sessionId);
  if (state !== undefined) stashed.delete(sessionId);
  return state;
}

export function discardStashedEditorState(sessionId: string): void {
  void takeEditorState(sessionId);
}

export function clearStashedEditorStates(): void {
  for (const [sessionId, state] of stashed) notifyStateDropped(sessionId, state);
  stashed.clear();
}
