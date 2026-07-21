import { describe, expect, it } from 'vitest';
import type { AppMessage, AppSession } from '../src/api';
import {
  createInitialState,
  reduceAppEvent,
  type EventMeta,
  type KimiClientState,
} from '../src/api/daemon/eventReducer';
import { shallowEqualArray, shallowEqualRecord } from '../src/api/daemon/sliceEquality';

const SID = 's_1';

let seq = 0;
function meta(): EventMeta {
  return { sessionId: SID, seq: ++seq };
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
    lastSeq: 0,
    workspaceId: 'workspace-1',
  };
}

function assistantMessage(id: string): AppMessage {
  return {
    id,
    sessionId: SID,
    role: 'assistant',
    content: [{ type: 'text', text: 'seed' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** State with one session and one assistant message, plus a turn in flight. */
function seededState(): KimiClientState {
  let state = createInitialState();
  state = reduceAppEvent(state, { type: 'sessionCreated', session: session(SID) }, meta());
  state = reduceAppEvent(state, { type: 'messageCreated', message: assistantMessage('m_1') }, meta());
  state = reduceAppEvent(
    state,
    { type: 'turnActiveChanged', sessionId: SID, active: true },
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

// applyEvent (apps' useKimiWebClient) skips assigning back slices whose
// contents a shallow compare reports as unchanged — these tests pin the
// reducer-side invariant that makes that skip correct: a pure streaming delta
// leaves every sidebar-relevant slice's CONTENTS identical.
describe('reduceAppEvent slice-content stability', () => {
  it('a pure assistantDelta changes only messagesBySession and lastSeqBySession', () => {
    const state = seededState();
    const next = reduceAppEvent(
      state,
      { type: 'assistantDelta', sessionId: SID, messageId: 'm_1', contentIndex: 0, delta: { text: ' more' } },
      meta(),
    );

    // Changed: the streamed message itself, and the seq watermark.
    expect(shallowEqualRecord(next.messagesBySession, state.messagesBySession)).toBe(false);
    expect(shallowEqualRecord(next.lastSeqBySession, state.lastSeqBySession)).toBe(false);
    expect(next.messagesBySession[SID]?.[0]?.content).toEqual([{ type: 'text', text: 'seed more' }]);

    // Unchanged: everything the sidebar / tasks / goal computeds read.
    expect(next.sessions).toBe(state.sessions);
    expect(shallowEqualRecord(next.turnActiveBySession, state.turnActiveBySession)).toBe(true);
    expect(shallowEqualRecord(next.approvalsBySession, state.approvalsBySession)).toBe(true);
    expect(shallowEqualRecord(next.questionsBySession, state.questionsBySession)).toBe(true);
    expect(shallowEqualRecord(next.tasksBySession, state.tasksBySession)).toBe(true);
    expect(shallowEqualRecord(next.goalBySession, state.goalBySession)).toBe(true);
    expect(shallowEqualRecord(next.goalVersionBySession, state.goalVersionBySession)).toBe(true);
    expect(shallowEqualRecord(next.turnEndedPromptIdBySession, state.turnEndedPromptIdBySession)).toBe(true);
    expect(shallowEqualRecord(next.compactionBySession, state.compactionBySession)).toBe(true);
    expect(shallowEqualRecord(next.planReviewByToolCallId, state.planReviewByToolCallId)).toBe(true);
    expect(shallowEqualArray(next.warnings, state.warnings)).toBe(true);
  });

  it('a real turn-state change is still detected by the shallow compare', () => {
    const state = seededState();
    const next = reduceAppEvent(
      state,
      { type: 'turnActiveChanged', sessionId: SID, active: false },
      meta(),
    );
    expect(shallowEqualRecord(next.turnActiveBySession, state.turnActiveBySession)).toBe(false);
    expect(next.turnActiveBySession[SID]).toBeUndefined();
  });
});
