/**
 * `activity` kernel unit tests — drives the real `AgentActivityService` with a
 * stub Session kernel and an in-memory wire service.
 *
 * Asserts the PR1 turn-lane contract: `begin` admits a turn and rejects a
 * concurrent one with `activity.agent_busy`, `cancel` moves the lane to
 * `turn(ending)` and aborts the lease signal, and `lease.end` returns the lane
 * to `idle` (idempotently). Run:
 * `pnpm test -- test/activity/activity.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, createServices, TestInstantiationService } from '#/_base/di/test';
import { IAgentActivityService, ISessionActivityKernel } from '#/activity/activity';
import type { ActivityLease } from '#/activity/activity';
import { AgentActivityService } from '#/activity/agentActivityService';
import { SessionActivityKernel } from '#/activity/sessionActivityKernel';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ErrorCodes } from '#/errors';
import { IAgentWireService, ISessionWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

import { stubSessionActivityKernel } from './stubs';

describe('AgentActivityService (turn lane)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let activity: IAgentActivityService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(
          IAgentWireService,
          disposables.add(new WireService({ logScope: 'wire', logKey: 'activity' })),
        );
        reg.defineInstance(ISessionActivityKernel, stubSessionActivityKernel());
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'agent', agentScope: 'agent' }),
        );
        reg.define(IAgentActivityService, AgentActivityService);
      },
    });
    activity = ix.get(IAgentActivityService);
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('starts initializing and admits a turn only after markReady', () => {
    expect(activity.lane()).toBe('initializing');
    expect(() => activity.begin('turn')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.ACTIVITY_INITIALIZING }),
    );
    activity.markReady();
    expect(activity.lane()).toBe('idle');
    const lease: ActivityLease = activity.begin('turn');
    expect(lease.kind).toBe('turn');
    expect(lease.signal.aborted).toBe(false);
    expect(activity.lane()).toBe('turn');
    lease.end('completed');
    expect(activity.lane()).toBe('idle');
  });

  it('rejects a concurrent begin with activity.agent_busy', () => {
    activity.markReady();
    const lease = activity.begin('turn');
    expect(() => activity.begin('turn')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.ACTIVITY_AGENT_BUSY }),
    );
    lease.end('completed');
  });

  it('tryBegin returns undefined when busy', () => {
    activity.markReady();
    const lease = activity.begin('turn');
    expect(activity.tryBegin('turn')).toBeUndefined();
    lease.end('completed');
  });

  it('cancel aborts the lease signal and keeps the lane until end', () => {
    activity.markReady();
    const lease = activity.begin('turn');
    expect(activity.cancel('stop')).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.ending).toBe(true);
    expect(activity.lane()).toBe('turn');
    lease.end('cancelled');
    expect(activity.lane()).toBe('idle');
  });

  it('cancel is a no-op when idle', () => {
    activity.markReady();
    expect(activity.cancel()).toBe(false);
  });

  it('lease.end is idempotent', () => {
    activity.markReady();
    const lease = activity.begin('turn');
    lease.end('completed');
    expect(() => lease.end('completed')).not.toThrow();
    expect(activity.lane()).toBe('idle');
  });

  it('beginDisposal aborts the in-flight lease and settles after end', async () => {
    activity.markReady();
    const lease = activity.begin('turn');
    activity.beginDisposal();
    expect(lease.signal.aborted).toBe(true);
    expect(activity.lane()).toBe('disposing');
    const settled = activity.settled();
    lease.end('cancelled');
    await settled;
    expect(activity.lane()).toBe('disposed');
  });
});

describe('SessionActivityKernel (session lane)', () => {
  let host: ReturnType<typeof createScopedTestHost>;
  let kernel: ISessionActivityKernel;

  function stubWire(): IWireService {
    return {
      _serviceBrand: undefined,
      dispatch: () => undefined,
      replay: () => Promise.resolve(),
      flush: () => Promise.resolve(),
      attach: () => ({ dispose: () => undefined }),
      getModel: (model: { initial: () => unknown }) => model.initial(),
      subscribe: () => ({ dispose: () => undefined }),
      onEmission: () => ({ dispose: () => undefined }),
      onRestored: () => ({ dispose: () => undefined }),
    } as unknown as IWireService;
  }

  beforeEach(() => {
    host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 'session', [
      [ISessionWireService, stubWire()],
    ]);
    kernel = session.accessor.get(ISessionActivityKernel);
  });

  afterEach(() => {
    host.dispose();
  });

  function fakeLease(turnId: number): ActivityLease {
    return {
      kind: 'turn',
      turnId,
      origin: { kind: 'user' },
      signal: new AbortController().signal,
      ending: false,
      end: () => undefined,
    };
  }

  it('starts restoring and only admits agent.create until active', () => {
    expect(kernel.lane()).toBe('restoring');
    expect(kernel.canAccept('agent.create')).toBe(true);
    expect(kernel.canAccept('turn.begin')).toBe(false);
    expect(kernel.canAccept('session.fork')).toBe(false);
    kernel.markActive();
    expect(kernel.lane()).toBe('active');
    expect(kernel.canAccept('turn.begin')).toBe(true);
  });

  it('admitTurn rejects while restoring and registers while active', () => {
    expect(() => kernel.admitTurn('agent', fakeLease(1))).toThrowError(
      expect.objectContaining({ code: ErrorCodes.ACTIVITY_SESSION_REJECTED }),
    );
    kernel.markActive();
    const reg = kernel.admitTurn('agent', fakeLease(1));
    reg.dispose();
  });

  it('quiesce flips to quiescing and restores to active on dispose', async () => {
    kernel.markActive();
    const lease = await kernel.quiesce('fork');
    expect(kernel.lane()).toBe('quiescing');
    expect(kernel.canAccept('turn.begin')).toBe(false);
    lease.dispose();
    expect(kernel.lane()).toBe('active');
  });

  it('quiesce waits for in-flight leases to drain', async () => {
    kernel.markActive();
    const reg = kernel.admitTurn('agent', fakeLease(1));
    let resolved = false;
    const pending = kernel.quiesce('fork').then((lease) => {
      resolved = true;
      return lease;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    reg.dispose();
    const lease = await pending;
    expect(resolved).toBe(true);
    expect(kernel.lane()).toBe('quiescing');
    lease.dispose();
  });
});
