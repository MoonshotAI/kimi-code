import { describe, expect, it, vi } from 'vitest';
import { BrowserControlOwnershipState } from '../../../src/main/browser/browser-control-ownership';
import { BrowserSubagentRunRegistry } from '../../../src/main/browser/browser-subagent-control';
import { browserControlDuration, type BrowserControlPresentation } from '../../../src/shared/browser-control';

const control: BrowserControlPresentation = { browserId: 'browser-1', sessionId: 'session-1', turnId: 'turn-1', status: 'running' };

describe('browser control ownership', () => {
  it('blocks retries and other tabs in the same turn without affecting other sessions', () => {
    const state = new BrowserControlOwnershipState();
    state.sync([control, { ...control, browserId: 'browser-2', status: 'idle' }, { ...control, browserId: 'browser-3', sessionId: 'session-2' }]);
    expect(state.takeOver('browser-1')).toBe(true);
    expect(() => state.assertAllowed('session-1')).toThrow('manually taken over');
    state.sync([{ ...control, browserId: 'browser-2' }]);
    expect(() => state.assertAllowed(state.sessionFor('browser-2'))).toThrow('manually taken over');
    expect(() => state.assertAllowed('session-2')).not.toThrow();
    expect(state.snapshot().browserIds).toEqual(['browser-1', 'browser-2']);
  });

  it('restores runs revoked by settings without reviving stale requests or user takeovers', () => {
    const state = new BrowserControlOwnershipState();
    const revoked = { agentId: 'revoked', generation: 1, turnId: 1 };
    const taken = { agentId: 'taken', generation: 1, turnId: 1 };
    const takenAfterRevoke = { agentId: 'taken-after-revoke', generation: 1, turnId: 1 };
    state.sync([
      { ...control, controller: { run: taken } },
      { ...control, browserId: 'browser-2', sessionId: 'session-2', controller: { run: takenAfterRevoke } },
    ]);
    const stale = state.revision('session-1', revoked);
    state.revoke('session-1', revoked);
    state.takeOver('browser-1');
    state.revoke('session-1', taken);
    state.revoke('session-2', takenAfterRevoke);
    expect(state.takeOver('browser-2')).toBe(false);

    expect(state.restoreRevokedRuns()).toBe(true);
    expect(() => state.assertAllowed('session-1', state.revision('session-1', revoked), revoked)).not.toThrow();
    expect(() => state.assertAllowed('session-1', stale, revoked)).toThrow('Browser control changed');
    expect(() => state.assertAllowed('session-1', undefined, taken)).toThrow('manually taken over');
    expect(() => state.assertAllowed('session-2', undefined, takenAfterRevoke)).toThrow('manually taken over');
    expect(state.restoreRevokedRuns()).toBe(false);
  });

  it('retains the block when a turn ends and releases it only for a new turn', () => {
    const state = new BrowserControlOwnershipState();
    state.sync([control]);
    state.takeOver(control.browserId);
    state.sync([{ ...control, status: 'idle', turnId: null }]);
    expect(state.isBlocked(control.sessionId)).toBe(true);
    state.observeTurn(control.sessionId, 'turn-1');
    expect(state.isBlocked(control.sessionId)).toBe(true);
    state.observeTurn(control.sessionId, 'turn-2');
    expect(state.isBlocked(control.sessionId)).toBe(false);
  });

  it('does not allow an old queued input after the user starts a new turn', () => {
    const state = new BrowserControlOwnershipState();
    state.sync([control]);
    const revision = state.revision(control.sessionId);
    state.takeOver(control.browserId);
    state.observeTurn(control.sessionId, 'turn-2');
    expect(() => state.assertAllowed(control.sessionId, revision)).toThrow('manually taken over');
    expect(() => state.assertAllowed(control.sessionId, state.revision(control.sessionId))).not.toThrow();
  });

  it('keeps elapsed control time across tabs and excludes time waiting for input', () => {
    const state = new BrowserControlOwnershipState();
    state.sync([control], 1000);
    state.sync([{ ...control, browserId: 'browser-2' }], 3000);
    expect(state.startedAt(control.sessionId)).toBe(1000);
    state.sync([{ ...control, status: 'paused' }], 5000);
    state.sync([{ ...control, status: 'running' }], 15000);
    expect(state.startedAt(control.sessionId)).toBe(11000);
    state.sync([{ ...control, turnId: 'turn-2' }], 20000);
    expect(state.startedAt(control.sessionId)).toBe(20000);
  });

  it('starts a new timer after explicit release in the same turn', () => {
    const state = new BrowserControlOwnershipState();
    state.sync([control], 1000);
    state.sync([{ ...control, status: 'idle' }], 3000);
    state.sync([control], 5000);
    expect(state.startedAt(control.sessionId)).toBe(5000);
    expect(browserControlDuration(0, 270000)).toBe('4:30');
    expect(browserControlDuration(1000, 0)).toBe('0:00');
  });

  it('invalidates transferred run leases while takeover blocks only the current run', () => {
    const state = new BrowserControlOwnershipState();
    const first = { agentId: 'agent-1', generation: 2, turnId: 7 };
    const second = { agentId: 'agent-2', generation: 3, turnId: 4 };
    const forRun = (run: typeof first): BrowserControlPresentation => ({
      browserId: 'browser-1', sessionId: 'session-1', turnId: String(run.turnId), status: 'running', controller: { run },
    });
    state.sync([forRun(first)], 1000);
    const firstRevision = state.revision('session-1', first);
    state.sync([forRun(second)], 2000);
    expect(state.revision('session-1', first)).toBe(firstRevision + 1);
    expect(state.isBlocked('session-1', first)).toBe(false);
    expect(() => state.assertAllowed('session-1', firstRevision, first)).toThrow('Browser control changed');
    expect(() => state.assertAllowed('session-1', state.revision('session-1', first), first)).not.toThrow();
    expect(state.startedAt('session-1', second)).toBe(2000);

    expect(state.takeOver('browser-1')).toBe(true);
    expect(state.isBlocked('session-1', second)).toBe(true);
    expect(state.isBlocked('session-1', first)).toBe(false);
    expect(state.snapshot().runs).toEqual([{ sessionId: 'session-1', run: second }]);

    const nextTurn = { ...first, turnId: 8 };
    state.sync([forRun(nextTurn)], 3000);
    expect(state.isBlocked('session-1', nextTurn)).toBe(false);
    expect(() => state.assertAllowed('session-1', state.revision('session-1', nextTurn), nextTurn)).not.toThrow();
    state.revoke('session-1', nextTurn);
    expect(state.isBlocked('session-1', nextTurn)).toBe(true);
  });
});

describe('subagent run registry', () => {
  it('accepts only eligible live runs and revokes disable, completion and close', () => {
    let enabled = true;
    let running = true;
    let eligible = true;
    let turnId = 7;
    const registry = new BrowserSubagentRunRegistry(() => enabled);
    const revoked = vi.fn();
    registry.onDidRevoke(revoked);
    registry.attach('session-1', {
      agentId: 'agent-1', generation: 2,
      state: () => ({ running, turnId, profile: 'coder', eligible }),
    });
    registry.describe('session-1', 'agent-1', 2, 'Inspect docs');
    const run = { agentId: 'agent-1', generation: 2, turnId: 7 };
    const controller = registry.resolve('session-1', run)!;
    expect(controller).toMatchObject({ run, profile: 'coder', description: 'Inspect docs' });
    expect(() => controller.assertActive()).not.toThrow();
    expect(registry.resolve('session-1', { ...run, generation: 1 })).toBeNull();
    expect(registry.resolve('session-1', { ...run, turnId: 8 })).toBeNull();

    enabled = false;
    expect(registry.resolve('session-1', run)).toBeNull();
    expect(() => controller.assertActive()).toThrow('not currently running');
    enabled = true;
    turnId = 8;
    expect(registry.resolve('session-1', run)).toBeNull();
    expect(revoked).toHaveBeenCalledWith('session-1', run);

    const current = registry.resolve('session-1', { ...run, turnId: 8 })!;
    running = false;
    expect(registry.resolve('session-1', { ...run, turnId: 8 })).toBeNull();
    expect(() => current.assertActive()).toThrow('not currently running');

    running = true;
    const reopened = registry.resolve('session-1', { ...run, turnId: 8 })!;
    registry.closeAgent('session-1', 'agent-1', 2);
    expect(registry.resolve('session-1', { ...run, turnId: 8 })).toBeNull();
    expect(() => reopened.assertActive()).toThrow('not currently running');

    eligible = false;
    registry.attach('session-1', { agentId: 'agent-1', generation: 2, state: () => ({ running, turnId, profile: 'explore', eligible }) });
    expect(registry.resolve('session-1', { ...run, turnId: 8 })).toBeNull();
  });
});
