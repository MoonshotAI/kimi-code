import { afterEach, describe, expect, it } from 'vitest';
import type { EditorState } from 'prosemirror-state';
import { clearStashedEditorStates, stashEditorState, takeEditorState } from '../src/lib/editorStateCache';

// The cache only stores/returns identities, so plain objects stand in for
// real EditorStates.
function fakeState(tag: string): EditorState {
  return { tag } as unknown as EditorState;
}

describe('editorStateCache', () => {
  afterEach(() => {
    clearStashedEditorStates();
  });

  it('takes back a stashed state by session id', () => {
    const state = fakeState('a');
    stashEditorState('s1', state);
    expect(takeEditorState('s1')).toBe(state);
  });

  it('returns undefined for an unknown session', () => {
    expect(takeEditorState('nope')).toBeUndefined();
  });

  it('take is destructive — a second take finds nothing', () => {
    stashEditorState('s1', fakeState('a'));
    expect(takeEditorState('s1')).toBeDefined();
    expect(takeEditorState('s1')).toBeUndefined();
  });

  it('re-stashing overwrites the previous state for the session', () => {
    stashEditorState('s1', fakeState('old'));
    const newer = fakeState('new');
    stashEditorState('s1', newer);
    expect(takeEditorState('s1')).toBe(newer);
  });

  it('evicts the least-recently-stashed session beyond the cap', () => {
    for (let i = 0; i < 50; i++) stashEditorState(`s${i}`, fakeState(`${i}`));
    // Bump s0 so it is no longer the oldest.
    stashEditorState('s0', fakeState('0-new'));
    stashEditorState('overflow', fakeState('x'));

    expect(takeEditorState('s0')).toBeDefined(); // refreshed, survives
    expect(takeEditorState('s1')).toBeUndefined(); // oldest, evicted
    expect(takeEditorState('overflow')).toBeDefined();
    expect(takeEditorState('s49')).toBeDefined();
  });
});
