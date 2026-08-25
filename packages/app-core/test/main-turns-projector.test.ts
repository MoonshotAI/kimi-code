import { describe, expect, it } from 'vitest';
import type { AgentTranscriptSnapshot, TranscriptTurn } from '../src/transcript';

import { createMainTurnsProjector } from '../src/client/mainTurnsProjector';

const DEPS = { sessionId: 's1' };

describe('createMainTurnsProjector', () => {
  it('reuses unchanged turn objects and rebuilds only the changed ones', () => {
    const projector = createMainTurnsProjector();
    const first = projector(snapshot([baseTurn(), assistantTurn('turn-2', 'answer one')]), DEPS);

    const second = projector(snapshot([baseTurn(), assistantTurn('turn-2', 'answer one')]), DEPS);
    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i]);
    }

    const third = projector(snapshot([baseTurn(), assistantTurn('turn-2', 'answer two')]), DEPS);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).toBe(first[1]);
    const changed = third.findIndex((turn) => turn.text === 'answer two');
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(third[changed]).not.toBe(first[changed]);
  });

  it('does not shift a turn into another slot when history prepends', () => {
    const projector = createMainTurnsProjector();
    const first = projector(snapshot([assistantTurn('turn-2', 'answer one')]), DEPS);

    const prepended = projector(snapshot([baseTurn(), assistantTurn('turn-2', 'answer one')]), DEPS);
    expect(prepended).toHaveLength(first.length + 2);
    for (const turn of prepended) {
      expect(first.includes(turn)).toBe(false);
    }

    const again = projector(snapshot([baseTurn(), assistantTurn('turn-2', 'answer one')]), DEPS);
    for (let i = 0; i < prepended.length; i++) {
      expect(again[i]).toBe(prepended[i]);
    }
  });

  it('reset drops the reuse cache', () => {
    const projector = createMainTurnsProjector();
    const first = projector(snapshot([baseTurn()]), DEPS);
    projector.reset();
    const second = projector(snapshot([baseTurn()]), DEPS);
    expect(second[0]).not.toBe(first[0]);
  });
});

function baseTurn(): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: 'turn-1',
    ordinal: 1,
    state: 'completed',
    origin: { kind: 'user', payload: { kind: 'user' } },
    prompt: 'Inspect the renderer',
    startedAt: '2026-07-27T00:00:00.000Z',
    endedAt: '2026-07-27T00:00:04.000Z',
    steps: [{
      kind: 'step',
      stepId: 'turn-1:1',
      turnId: 'turn-1',
      ordinal: 1,
      state: 'completed',
      frames: [{ kind: 'text', frameId: 'f1', role: 'assistant', text: 'Found the cause.' }],
    }],
  };
}

function assistantTurn(turnId: string, text: string): TranscriptTurn {
  return {
    kind: 'turn',
    turnId,
    ordinal: 2,
    state: 'completed',
    origin: { kind: 'user', payload: { kind: 'user' } },
    prompt: 'next question',
    startedAt: '2026-07-27T00:01:00.000Z',
    endedAt: '2026-07-27T00:01:04.000Z',
    steps: [{
      kind: 'step',
      stepId: `${turnId}:1`,
      turnId,
      ordinal: 1,
      state: 'completed',
      frames: [{ kind: 'text', frameId: 'f1', role: 'assistant', text }],
    }],
  };
}

function snapshot(turns: TranscriptTurn[]): AgentTranscriptSnapshot {
  return {
    items: turns,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'idle' },
    hasMoreOlder: false,
  };
}
