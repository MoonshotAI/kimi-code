import { describe, expect, it } from 'vitest';

import { MODEL_CROSS_REDUCERS } from '#/wire/model';
import { TurnModel, cancelTurn, endTurn, promptTurn } from '#/agent/loop/turnOps';

function foldLoopEvent(s: import('#/agent/loop/turnOps').TurnModelState, turnId: string) {
  const entries = MODEL_CROSS_REDUCERS.get('context.append_loop_event') ?? [];
  const entry = entries.find((e) => e.model === TurnModel);
  if (entry === undefined) throw new Error('turn model cross-reducer not registered');
  return entry.reducer(s, { event: { type: 'step.begin', turnId } }) as typeof s;
}

describe('TurnModel lastEnded', () => {
  it('keeps the stored outcome across prompts and queued cancels', () => {
    let s = TurnModel.initial();
    s = promptTurn.apply(s, { input: [], origin: { kind: 'user' } });
    s = endTurn.apply(s, { turnId: 0, reason: 'failed', durationMs: 10 });
    expect(s.lastEnded).toMatchObject({ turnId: 0, reason: 'failed' });
    s = promptTurn.apply(s, { input: [], origin: { kind: 'user' } });
    expect(s.lastEnded?.reason).toBe('failed');
    s = cancelTurn.apply(s, { turnId: 1, target: 'queued' });
    expect(s.lastEnded?.reason).toBe('failed');
    s = endTurn.apply(s, { turnId: 1, reason: 'completed' });
    expect(s.lastEnded).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the stored outcome once a newer turn starts producing', () => {
    let s = TurnModel.initial();
    s = promptTurn.apply(s, { input: [], origin: { kind: 'user' } });
    s = endTurn.apply(s, { turnId: 0, reason: 'failed' });
    s = promptTurn.apply(s, { input: [], origin: { kind: 'user' } });
    s = foldLoopEvent(s, '1');
    expect(s.lastEnded).toBeUndefined();
  });

  it('keeps the stored outcome on the same turn’s own events', () => {
    let s = TurnModel.initial();
    s = promptTurn.apply(s, { input: [], origin: { kind: 'user' } });
    s = foldLoopEvent(s, '0');
    s = endTurn.apply(s, { turnId: 0, reason: 'completed' });
    s = foldLoopEvent(s, '0');
    expect(s.lastEnded?.reason).toBe('completed');
  });

  it('starts without a stored outcome', () => {
    expect(TurnModel.initial().lastEnded).toBeUndefined();
  });
});
