import { describe, expect, it } from 'vitest';
import type { AppSession } from '../src/api';
import {
  createInitialState,
  reduceAppEvent,
  type EventMeta,
  type KimiClientState,
} from '../src/api/daemon/eventReducer';
import { shallowEqualArray, shallowEqualRecord } from '../src/api/daemon/sliceEquality';

const SID = 's_1';

function meta(): EventMeta {
  return { sessionId: SID };
}

function session(id: string): AppSession {
  return {
    id,
    title: 'Session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    archived: false,
    cwd: '/workspace',
    model: 'model-1',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    workspaceId: 'workspace-1',
  };
}

function seededState(): KimiClientState {
  let state = createInitialState();
  state = reduceAppEvent(state, { type: 'sessionCreated', session: session(SID) }, meta());
  state = reduceAppEvent(
    state,
    { type: 'sessionWorkChanged', sessionId: SID, busy: true, mainTurnActive: true },
    meta(),
  );
  return state;
}

describe('shallowEqualRecord / shallowEqualArray', () => {
  it('treats clones with identical entries as equal', () => {
    const inner = [1, 2];
    expect(shallowEqualRecord({ a: inner }, { a: inner })).toBe(true);
    expect(shallowEqualRecord({ a: inner }, { a: [...inner] })).toBe(false);
    expect(shallowEqualRecord({ a: inner }, { a: inner, b: inner })).toBe(false);
    expect(shallowEqualRecord({ a: inner }, {})).toBe(false);
    expect(shallowEqualArray([inner, inner], [inner, inner])).toBe(true);
    expect(shallowEqualArray([inner], [[...inner]])).toBe(false);
    expect(shallowEqualArray([inner], [inner, inner])).toBe(false);
  });
});

describe('reduceAppEvent slice-content stability', () => {
  it('a no-op event leaves every slice unchanged', () => {
    const state = seededState();
    const next = reduceAppEvent(
      state,
      { type: 'unknown', raw: { _noop: true, _wireType: 'event.capability.changed' } },
      meta(),
    );

    expect(next.sessions).toBe(state.sessions);
    expect(shallowEqualRecord(next.approvalsBySession, state.approvalsBySession)).toBe(true);
    expect(shallowEqualRecord(next.questionsBySession, state.questionsBySession)).toBe(true);
    expect(shallowEqualRecord(next.goalBySession, state.goalBySession)).toBe(true);
    expect(shallowEqualRecord(next.goalVersionBySession, state.goalVersionBySession)).toBe(true);
    expect(shallowEqualArray(next.warnings, state.warnings)).toBe(true);
  });

  it('a real turn-state change is still detected by the shallow compare', () => {
    const state = seededState();
    const next = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: SID, busy: false, mainTurnActive: false },
      meta(),
    );
    expect(shallowEqualArray(next.sessions, state.sessions)).toBe(false);
    expect(next.sessions[0]?.mainTurnActive).toBe(false);
  });
});
