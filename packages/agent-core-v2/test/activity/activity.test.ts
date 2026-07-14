/**
 * `activity` kernel unit tests — drives the real `AgentActivityService` with a
 * stub Session kernel, event bus and in-memory wire service.
 *
 * Asserts turn admission and lifecycle transitions plus the live projection of
 * streaming, tool calls, approvals, retries and step interruptions. Run:
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
import type { PermissionApprovalRequestContext } from '#/agent/permissionGate/permissionGateService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ErrorCodes } from '#/errors';

import { stubSessionActivityKernel } from './stubs';
import { registerTestAgentWireServices } from '../wire/stubs';

describe('AgentActivityService (turn lane)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let activity: IAgentActivityService;
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg, 'wire/activity');
        reg.defineInstance(ISessionActivityKernel, stubSessionActivityKernel());
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'agent', agentScope: 'agent' }),
        );
        reg.define(IEventBus, EventBusService);
        reg.define(IAgentActivityService, AgentActivityService);
      },
    });
    activity = ix.get(IAgentActivityService);
    eventBus = ix.get(IEventBus);
  });

  afterEach(() => {
    disposables.dispose();
  });

  function collectActivity(): DomainEvent<'agent.activity.updated'>[] {
    const snapshots: DomainEvent<'agent.activity.updated'>[] = [];
    disposables.add(
      eventBus.subscribe('agent.activity.updated', (snapshot) => snapshots.push(snapshot)),
    );
    return snapshots;
  }

  function startTurn(): ActivityLease {
    activity.markReady();
    const lease = activity.begin('turn', { turnId: 1 });
    eventBus.publish({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });
    eventBus.publish({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 's1' });
    return lease;
  }

  it('starts initializing and admits a turn only after markReady', () => {
    expect(activity.isIdle()).toBe(false);
    expect(() => activity.begin('turn')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.ACTIVITY_INITIALIZING }),
    );
    activity.markReady();
    expect(activity.isIdle()).toBe(true);
    const lease: ActivityLease = activity.begin('turn');
    expect(lease.kind).toBe('turn');
    expect(lease.signal.aborted).toBe(false);
    expect(activity.isIdle()).toBe(false);
    lease.end('completed');
    expect(activity.isIdle()).toBe(true);
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

  it('cancel aborts the lease signal and keeps the turn active until end', () => {
    activity.markReady();
    const lease = activity.begin('turn');
    expect(activity.cancel('stop')).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.ending).toBe(true);
    expect(activity.isIdle()).toBe(false);
    lease.end('cancelled');
    expect(activity.isIdle()).toBe(true);
  });

  it('publishes lifecycle independently from turn activity', () => {
    const states: Array<{ lifecycle: string; hasTurn: boolean; ending?: boolean }> = [];
    disposables.add(
      eventBus.subscribe('agent.activity.updated', (state) => {
        states.push({
          lifecycle: state.lifecycle,
          hasTurn: state.turn !== undefined,
          ending: state.turn?.ending,
        });
      }),
    );

    activity.markReady();
    const lease = activity.begin('turn');
    activity.cancel();
    lease.end('cancelled');

    expect(states).toEqual([
      { lifecycle: 'ready', hasTurn: false, ending: undefined },
      { lifecycle: 'ready', hasTurn: true, ending: false },
      { lifecycle: 'ready', hasTurn: true, ending: true },
      { lifecycle: 'ready', hasTurn: false, ending: undefined },
    ]);
  });

  it('publishes the first streaming delta and suppresses equivalent deltas', () => {
    const snapshots = collectActivity();
    const lease = startTurn();
    const baseline = snapshots.length;

    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'he' });
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'llo' });

    expect(snapshots).toHaveLength(baseline + 1);
    expect(snapshots.at(-1)?.turn).toMatchObject({ phase: 'streaming', stream: 'assistant' });
    lease.end('completed');
  });

  it('projects active tool calls until their results arrive', () => {
    const snapshots = collectActivity();
    const lease = startTurn();

    eventBus.publish({ type: 'tool.call.started', turnId: 1, toolCallId: 'c1', name: 'Read', args: {} });
    eventBus.publish({ type: 'tool.call.started', turnId: 1, toolCallId: 'c2', name: 'Write', args: {} });
    expect(snapshots.at(-1)?.turn?.activeToolCalls.map((tool) => tool.toolCallId)).toEqual([
      'c1',
      'c2',
    ]);

    eventBus.publish({ type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'ok', isError: false });
    expect(snapshots.at(-1)?.turn?.activeToolCalls.map((tool) => tool.toolCallId)).toEqual(['c2']);
    lease.end('completed');
  });

  it('projects all pending approvals until each is resolved', () => {
    const snapshots = collectActivity();
    const lease = startTurn();
    const approval = (toolCallId: string): PermissionApprovalRequestContext =>
      ({
        toolCallId,
        toolName: 'Read',
        action: 'read',
        display: {},
        turnId: 1,
        toolInput: { path: '/tmp/example' },
      }) as unknown as PermissionApprovalRequestContext;

    eventBus.publish({ type: 'permission.approval.requested', ...approval('c1') });
    eventBus.publish({ type: 'permission.approval.requested', ...approval('c2') });
    expect(snapshots.at(-1)?.turn?.pendingApprovals.map((item) => item.toolCallId)).toEqual([
      'c1',
      'c2',
    ]);

    eventBus.publish({
      type: 'permission.approval.resolved',
      ...approval('c1'),
      decision: 'approved',
    });
    expect(snapshots.at(-1)?.turn?.pendingApprovals.map((item) => item.toolCallId)).toEqual(['c2']);
    lease.end('completed');
  });

  it('projects retry state for the active turn', () => {
    const snapshots = collectActivity();
    const lease = startTurn();

    eventBus.publish({
      type: 'turn.step.retrying',
      turnId: 1,
      step: 1,
      stepId: 's1',
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorName: 'RateLimitError',
      errorMessage: 'slow down',
      statusCode: 429,
    });

    expect(snapshots.at(-1)?.turn).toMatchObject({
      phase: 'retrying',
      retry: {
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        errorName: 'RateLimitError',
        statusCode: 429,
      },
    });
    lease.end('completed');
  });

  it.each(['max_steps', 'error'] as const)(
    'projects %s as the ending reason when a step is interrupted',
    (reason) => {
      const snapshots = collectActivity();
      const lease = startTurn();

      eventBus.publish({
        type: 'turn.step.interrupted',
        turnId: 1,
        step: 1,
        reason,
      });

      expect(snapshots.at(-1)?.turn).toMatchObject({
        turnId: 1,
        step: 1,
        ending: true,
        endingReason: reason,
      });
      lease.end('failed');
    },
  );

  it('cancel is a no-op when idle', () => {
    activity.markReady();
    expect(activity.cancel()).toBe(false);
  });

  it('lease.end is idempotent', () => {
    activity.markReady();
    const lease = activity.begin('turn');
    lease.end('completed');
    expect(() => lease.end('completed')).not.toThrow();
    expect(activity.isIdle()).toBe(true);
  });

  it('beginDisposal aborts the in-flight lease and settles after end', async () => {
    const states = collectActivity();
    activity.markReady();
    const lease = activity.begin('turn');
    activity.beginDisposal();
    expect(lease.signal.aborted).toBe(true);
    expect(activity.isIdle()).toBe(false);
    expect(states.at(-1)).toMatchObject({ lifecycle: 'disposing', turn: { turnId: lease.turnId } });
    const settled = activity.settled();
    lease.end('cancelled');
    await settled;
    expect(activity.isIdle()).toBe(false);
    expect(states.at(-1)).toMatchObject({ lifecycle: 'disposed', turn: undefined });
  });
});

describe('SessionActivityKernel (session lane)', () => {
  let host: ReturnType<typeof createScopedTestHost>;
  let kernel: ISessionActivityKernel;

  beforeEach(() => {
    host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 'session');
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
