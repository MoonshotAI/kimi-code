import { describe, expect, it } from 'vitest';

import { TurnEnded } from '#/actor/loop/turnOps';

describe('TurnEnded serialization', () => {
  it('emits the op record shape without the bus-only interruptReason', () => {
    const event = new TurnEnded(
      {
        agentId: 'main',
        turnId: 3,
        reason: 'cancelled',
        durationMs: 12,
        interruptReason: 'user_cancelled',
      },
      42,
    );
    expect(event.serialize()).toEqual({
      type: 'turn.ended',
      agentId: 'main',
      turnId: 3,
      reason: 'cancelled',
      durationMs: 12,
      time: 42,
    });
  });

  it('omits absent optional fields from the record', () => {
    const event = new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }, 7);
    expect(event.serialize()).toEqual({
      type: 'turn.ended',
      agentId: 'main',
      turnId: 0,
      reason: 'completed',
      time: 7,
    });
  });
});
