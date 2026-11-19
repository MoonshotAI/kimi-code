import { afterEach, describe, expect, it } from 'vitest';
import type { EditorState } from 'prosemirror-state';
import {
  clearStashedEditorStates,
  onStashedStateDropped,
  stashEditorState,
  takeEditorState,
} from '../../src/runtime/editorStateCache';

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
    const dropped: string[] = [];
    const release = onStashedStateDropped((sessionId) => dropped.push(sessionId));
    for (let i = 0; i < 50; i++) stashEditorState(`s${i}`, fakeState(`${i}`));
    stashEditorState('s0', fakeState('0-new'));
    stashEditorState('overflow', fakeState('x'));

    expect(dropped).toEqual(['s1']);
    expect(takeEditorState('s0')).toBeDefined();
    expect(takeEditorState('s1')).toBeUndefined();
    expect(takeEditorState('overflow')).toBeDefined();
    expect(takeEditorState('s49')).toBeDefined();
    release();
  });
});
