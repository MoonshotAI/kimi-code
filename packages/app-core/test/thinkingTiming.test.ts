import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTranscriptSnapshot, TranscriptInteraction, TranscriptTurn } from '../src/transcript';

import {
  pruneThinkingSpans,
  settleClosedThinkingSpans,
  type ThinkingTimingMap,
} from '../src/client';

describe('settleClosedThinkingSpans', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T01:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('freezes a stamped span when its step completes, without any projection', () => {
    const timing = openStamp();
    settleClosedThinkingSpans(snapshotWith('completed'), timing);
    expect(timing.get('turn-1.1.f1')?.settledAt).toBe('2026-08-26T01:00:00.000Z');
  });

  it('keeps a span open while its frame can still receive appends', () => {
    const timing = openStamp();
    settleClosedThinkingSpans(snapshotWith('running'), timing);
    expect(timing.get('turn-1.1.f1')?.settledAt).toBeUndefined();
  });

  it('freezes a span when a later frame takes over within a running step', () => {
    const timing = openStamp();
    const snapshot = snapshotWith('running');
    const turn = snapshot.items[0];
    if (turn?.kind !== 'turn') throw new Error('expected turn fixture');
    turn.steps[0]?.frames.push({ kind: 'text', frameId: 'turn-1.1.f2', role: 'assistant', text: 'Hi' });
    settleClosedThinkingSpans(snapshot, timing);
    expect(timing.get('turn-1.1.f1')?.settledAt).toBe('2026-08-26T01:00:00.000Z');
  });

  it('freezes a span when an interaction suspends its step, and not without the interaction', () => {
    const pending: TranscriptInteraction = {
      interactionId: 'int-1',
      interactionKind: 'approval',
      state: 'pending',
    };
    const suspended = openStamp();
    settleClosedThinkingSpans(snapshotWith('running', [pending]), suspended);
    expect(suspended.get('turn-1.1.f1')?.settledAt).toBe('2026-08-26T01:00:00.000Z');

    const answered = openStamp();
    settleClosedThinkingSpans(
      snapshotWith('running', [{ ...pending, state: 'approved' }]),
      answered,
    );
    expect(answered.get('turn-1.1.f1')?.settledAt).toBeUndefined();
  });

  it('never re-opens or moves an already-settled span', () => {
    const timing: ThinkingTimingMap = new Map([
      ['turn-1.1.f1', { startedAt: '2026-08-26T00:30:00.000Z', settledAt: '2026-08-26T00:31:00.000Z' }],
    ]);
    settleClosedThinkingSpans(snapshotWith('completed'), timing);
    expect(timing.get('turn-1.1.f1')?.settledAt).toBe('2026-08-26T00:31:00.000Z');
  });
});

describe('pruneThinkingSpans', () => {
  it('drops spans whose frame vanished after a re-anchor and keeps survivors', () => {
    const timing: ThinkingTimingMap = new Map([
      ['turn-1.1.f1', { startedAt: '2026-08-26T00:30:00.000Z' }],
      ['turn-9.9.f9', { startedAt: '2026-08-26T00:20:00.000Z' }],
    ]);
    pruneThinkingSpans(snapshotWith('running'), timing);
    // The gap-recovery survivor keeps its original first-visibility stamp —
    // clearing it would visibly reset a running clock.
    expect(timing.get('turn-1.1.f1')).toEqual({ startedAt: '2026-08-26T00:30:00.000Z' });
    // The undo-rewound frame is gone — a regenerated frame with the same id
    // must start a fresh clock.
    expect(timing.has('turn-9.9.f9')).toBe(false);
  });
});

function openStamp(): ThinkingTimingMap {
  return new Map([['turn-1.1.f1', { startedAt: '2026-08-26T00:59:00.000Z' }]]);
}

function snapshotWith(
  stepState: 'running' | 'completed',
  interactions: TranscriptInteraction[] = [],
): AgentTranscriptSnapshot {
  const turn: TranscriptTurn = {
    kind: 'turn',
    turnId: 'turn-1',
    ordinal: 1,
    state: stepState === 'running' ? 'running' : 'completed',
    origin: { kind: 'user' },
    prompt: 'Think hard',
    startedAt: '2026-08-26T00:00:00.000Z',
    steps: [{
      kind: 'step',
      stepId: 'turn-1.1',
      turnId: 'turn-1',
      ordinal: 1,
      state: stepState,
      startedAt: '2026-08-26T00:00:00.000Z',
      frames: [{ kind: 'thinking', frameId: 'turn-1.1.f1', text: 'Let me think' }],
    }],
  };
  return {
    items: [turn],
    tasks: [],
    interactions,
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: stepState === 'running' ? 'turn' : 'idle' },
    hasMoreOlder: false,
  };
}
