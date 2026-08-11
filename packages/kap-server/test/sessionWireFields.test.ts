import { describe, expect, it } from 'vitest';

import { toWireSession, type SessionFacts, type SessionWireFields } from '../src/routes/sessions';

const fields: SessionWireFields = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

const coldFacts: SessionFacts = {
  busy: false,
  mainTurnActive: false,
  pendingInteraction: 'none',
  live: false,
};

describe('toWireSession last_turn_reason', () => {
  it('falls back to the persisted outcome for a cold session', () => {
    const wire = toWireSession({ ...fields, lastTurnReason: 'failed' }, '/tmp/ws', coldFacts);
    expect(wire.last_turn_reason).toBe('failed');
  });

  it('prefers the live fact for a warm session', () => {
    const wire = toWireSession({ ...fields, lastTurnReason: 'failed' }, '/tmp/ws', {
      ...coldFacts,
      lastTurnReason: 'completed',
    });
    expect(wire.last_turn_reason).toBe('completed');
  });

  it('omits the outcome when neither side has one', () => {
    expect(toWireSession(fields, '/tmp/ws', coldFacts).last_turn_reason).toBeUndefined();
  });

  it('never falls back for a live session mid-turn (no stale outcome)', () => {
    const busyFacts: SessionFacts = { busy: true, mainTurnActive: true, pendingInteraction: 'none', live: true };
    const wire = toWireSession({ ...fields, lastTurnReason: 'failed' }, '/tmp/ws', busyFacts);
    expect(wire.last_turn_reason).toBeUndefined();
  });

  it('a warm session without a live outcome does not read the persisted one', () => {
    const wire = toWireSession(
      { ...fields, lastTurnReason: 'failed' },
      '/tmp/ws',
      { ...coldFacts, live: true },
    );
    expect(wire.last_turn_reason).toBeUndefined();
  });
});
