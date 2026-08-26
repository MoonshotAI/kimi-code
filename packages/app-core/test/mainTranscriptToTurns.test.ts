import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTranscriptSnapshot } from '../src/transcript';

import { mainTranscriptToTurns, type ChatTurn, type ThinkingTimingMap } from '../src/client';

describe('mainTranscriptToTurns thinking timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T01:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a live thinking clock at first visibility, not at the daemon step start', () => {
    const timing: ThinkingTimingMap = new Map();
    const turns = mainTranscriptToTurns(liveThinkingSnapshot(), {
      sessionId: 's1',
      thinkingTiming: timing,
    });
    const block = thinkingBlock(turns);
    // The daemon step began at 00:00 — one hour of queue/prefill wait must
    // not be billed as thinking: the clock starts at the client's first
    // projection of the streaming frame.
    expect(block.startedAt).toBe('2026-08-26T01:00:00.000Z');
    expect(block.durationMs).toBeUndefined();
    expect(timing.get('turn-1.1.f1')).toEqual({ startedAt: '2026-08-26T01:00:00.000Z' });
  });

  it('keeps the first-visibility stamp across projections and freezes the span when the step ends', () => {
    const timing: ThinkingTimingMap = new Map();
    const deps = { sessionId: 's1', thinkingTiming: timing };
    const first = thinkingBlock(mainTranscriptToTurns(liveThinkingSnapshot(), deps));
    expect(first.startedAt).toBe('2026-08-26T01:00:00.000Z');

    vi.setSystemTime(new Date('2026-08-26T01:00:30.000Z'));
    const settled = thinkingBlock(mainTranscriptToTurns(completedThinkingSnapshot(), deps));
    // 30s client-observed streaming — NOT the 40s daemon step bounds.
    expect(settled.startedAt).toBe('2026-08-26T01:00:00.000Z');
    expect(settled.durationMs).toBe(30_000);

    vi.setSystemTime(new Date('2026-08-26T01:05:00.000Z'));
    const again = thinkingBlock(mainTranscriptToTurns(completedThinkingSnapshot(), deps));
    expect(again.durationMs).toBe(30_000);
  });

  it('settles a live span when an interaction suspends the step', () => {
    const timing: ThinkingTimingMap = new Map();
    const deps = { sessionId: 's1', thinkingTiming: timing };
    thinkingBlock(mainTranscriptToTurns(liveThinkingSnapshot(), deps));

    vi.setSystemTime(new Date('2026-08-26T01:00:10.000Z'));
    const suspended = thinkingBlock(
      mainTranscriptToTurns(liveThinkingSnapshot(), {
        ...deps,
        // The daemon-domain pending stamp does not leak into the
        // client-clocked span; the settle rides the local observation.
        pendingInteractionAtByStepId: new Map([['turn-1.1', '2026-08-26T00:00:12.000Z']]),
      }),
    );
    expect(suspended.durationMs).toBe(10_000);

    const again = thinkingBlock(
      mainTranscriptToTurns(liveThinkingSnapshot(), {
        ...deps,
        pendingInteractionAtByStepId: new Map([['turn-1.1', '2026-08-26T00:00:12.000Z']]),
      }),
    );
    expect(again.durationMs).toBe(10_000);
  });

  it('keeps the daemon step bounds for thinking already closed at first sight', () => {
    const withMap = thinkingBlock(
      mainTranscriptToTurns(completedThinkingSnapshot(), {
        sessionId: 's1',
        thinkingTiming: new Map(),
      }),
    );
    expect(withMap.startedAt).toBe('2026-08-26T00:00:00.000Z');
    expect(withMap.durationMs).toBe(40_000);

    const withoutMap = thinkingBlock(
      mainTranscriptToTurns(completedThinkingSnapshot(), { sessionId: 's1' }),
    );
    expect(withoutMap.startedAt).toBe('2026-08-26T00:00:00.000Z');
    expect(withoutMap.durationMs).toBe(40_000);
  });

  it('keeps the daemon step start for a frame closed mid-step at first sight (reload mid-step)', () => {
    const timing: ThinkingTimingMap = new Map();
    const block = thinkingBlock(
      mainTranscriptToTurns(midStepClosedThinkingSnapshot(), {
        sessionId: 's1',
        thinkingTiming: timing,
      }),
    );
    // The true first-delta moment predates the client's window — fall back
    // to the step bounds rather than fabricating a fresh stamp.
    expect(block.startedAt).toBe('2026-08-26T00:00:00.000Z');
    expect(block.durationMs).toBeUndefined();
    expect(timing.size).toBe(0);
  });

  it('re-stamps a still-open frame after the timing store is cleared (reset/rewind)', () => {
    const timing: ThinkingTimingMap = new Map();
    const deps = { sessionId: 's1', thinkingTiming: timing };
    thinkingBlock(mainTranscriptToTurns(liveThinkingSnapshot(), deps));
    timing.clear();

    vi.setSystemTime(new Date('2026-08-26T01:02:00.000Z'));
    const block = thinkingBlock(mainTranscriptToTurns(liveThinkingSnapshot(), deps));
    expect(block.startedAt).toBe('2026-08-26T01:02:00.000Z');
  });
});

function thinkingBlock(turns: ChatTurn[]) {
  for (const turn of turns) {
    for (const block of turn.blocks ?? []) {
      if (block.kind === 'thinking') return block;
    }
  }
  throw new Error('thinking block not found');
}

function liveThinkingSnapshot(): AgentTranscriptSnapshot {
  return {
    items: [{
      kind: 'turn',
      turnId: 'turn-1',
      ordinal: 1,
      state: 'running',
      origin: { kind: 'user' },
      prompt: 'Think hard',
      startedAt: '2026-08-26T00:00:00.000Z',
      steps: [{
        kind: 'step',
        stepId: 'turn-1.1',
        turnId: 'turn-1',
        ordinal: 1,
        state: 'running',
        startedAt: '2026-08-26T00:00:00.000Z',
        frames: [{ kind: 'thinking', frameId: 'turn-1.1.f1', text: 'Let me think' }],
      }],
    }],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'turn' },
    hasMoreOlder: false,
  };
}

function completedThinkingSnapshot(): AgentTranscriptSnapshot {
  return {
    items: [{
      kind: 'turn',
      turnId: 'turn-1',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      prompt: 'Think hard',
      startedAt: '2026-08-26T00:00:00.000Z',
      endedAt: '2026-08-26T00:00:40.000Z',
      steps: [{
        kind: 'step',
        stepId: 'turn-1.1',
        turnId: 'turn-1',
        ordinal: 1,
        state: 'completed',
        startedAt: '2026-08-26T00:00:00.000Z',
        endedAt: '2026-08-26T00:00:40.000Z',
        frames: [
          { kind: 'thinking', frameId: 'turn-1.1.f1', text: 'Let me think' },
          { kind: 'text', frameId: 'turn-1.1.f2', role: 'assistant', text: 'Done.' },
        ],
      }],
    }],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'idle' },
    hasMoreOlder: false,
  };
}

function midStepClosedThinkingSnapshot(): AgentTranscriptSnapshot {
  const snapshot = completedThinkingSnapshot();
  const turn = snapshot.items[0];
  if (turn?.kind !== 'turn') throw new Error('expected turn fixture');
  return {
    ...snapshot,
    items: [{
      ...turn,
      state: 'running',
      endedAt: undefined,
      steps: turn.steps.map((step) => ({ ...step, state: 'running', endedAt: undefined })),
    }],
    meta: { activity: 'turn' },
  };
}
