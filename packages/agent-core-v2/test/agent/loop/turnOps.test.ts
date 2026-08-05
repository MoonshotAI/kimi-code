import { describe, expect, it } from 'vitest';

import { TurnModel, cancelTurn, endTurn, promptTurn } from '#/agent/loop/turnOps';

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

  it('starts without a stored outcome', () => {
    expect(TurnModel.initial().lastEnded).toBeUndefined();
  });
});
