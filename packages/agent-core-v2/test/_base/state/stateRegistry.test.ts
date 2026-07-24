import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import { BugIndicatingError } from '#/_base/errors/errors';
import { defineState, StateRegistry, type StateChange } from '#/_base/state/stateRegistry';
import { IStateService } from '#/app/state/state';
import { StateService } from '#/app/state/stateService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';

describe('StateRegistry', () => {
  const countKey = defineState('test.count', () => 0);
  const nameKey = defineState('test.name', () => 'anonymous');

  it('returns the initial value after register', () => {
    const registry = new StateRegistry();
    registry.register(countKey);
    expect(registry.get(countKey)).toBe(0);
  });

  it('reads back the value written by set', () => {
    const registry = new StateRegistry();
    registry.register(countKey);
    registry.set(countKey, 42);
    expect(registry.get(countKey)).toBe(42);
  });

  it('reports registered keys through has and entries', () => {
    const registry = new StateRegistry();
    expect(registry.has(countKey)).toBe(false);
    registry.register(countKey);
    registry.register(nameKey);
    expect(registry.has(countKey)).toBe(true);
    expect(registry.entries()).toEqual([
      ['test.count', 0],
      ['test.name', 'anonymous'],
    ]);
  });

  it('rejects duplicate registration', () => {
    const registry = new StateRegistry();
    registry.register(countKey);
    expect(() => registry.register(countKey)).toThrow(BugIndicatingError);
  });

  it('rejects get and set on an unregistered key', () => {
    const registry = new StateRegistry();
    expect(() => registry.get(countKey)).toThrow(BugIndicatingError);
    expect(() => registry.set(countKey, 1)).toThrow(BugIndicatingError);
  });

  it('notifies onDidChange only for the key that was set', () => {
    const registry = new StateRegistry();
    registry.register(countKey);
    registry.register(nameKey);
    const seen: number[] = [];
    registry.onDidChange(countKey)((value) => seen.push(value));
    registry.set(nameKey, 'bob');
    expect(seen).toEqual([]);
    registry.set(countKey, 7);
    expect(seen).toEqual([7]);
  });

  it('notifies onDidChangeAny for every set', () => {
    const registry = new StateRegistry();
    registry.register(countKey);
    registry.register(nameKey);
    const seen: StateChange[] = [];
    registry.onDidChangeAny((change) => seen.push(change));
    registry.set(countKey, 1);
    registry.set(nameKey, 'alice');
    expect(seen).toEqual([
      { key: 'test.count', value: 1 },
      { key: 'test.name', value: 'alice' },
    ]);
  });

  it('silences change events after dispose', () => {
    const registry = new StateRegistry();
    registry.register(countKey);
    const seen: StateChange[] = [];
    registry.onDidChangeAny((change) => seen.push(change));
    registry.dispose();
    registry.set(countKey, 1);
    expect(seen).toEqual([]);
    expect(registry.get(countKey)).toBe(1);
  });
});

describe('state services (scoped)', () => {
  let host: ScopedTestHost;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IStateService, StateService, InstantiationType.Eager, 'state');
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
      InstantiationType.Eager,
      'state',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgentStateService,
      AgentStateService,
      InstantiationType.Eager,
      'state',
    );
    host = createScopedTestHost();
  });

  afterEach(() => host.dispose());

  it('resolves a distinct state service per scope tier', () => {
    const appState = host.app.accessor.get(IStateService);
    const session = host.child(LifecycleScope.Session, 's1');
    const sessionState = session.accessor.get(ISessionStateService);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');
    const agentState = agent.accessor.get(IAgentStateService);
    expect(appState).not.toBe(sessionState);
    expect(sessionState).not.toBe(agentState);
  });

  it('keeps registered state invisible to sibling scope tiers', () => {
    const sessionKey = defineState('test.sessionOnly', () => 'seed');
    const session = host.child(LifecycleScope.Session, 's1');
    const sessionState = session.accessor.get(ISessionStateService);
    sessionState.register(sessionKey);
    sessionState.set(sessionKey, 'live');
    expect(sessionState.get(sessionKey)).toBe('live');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');
    expect(agent.accessor.get(IAgentStateService).has(sessionKey)).toBe(false);
    expect(host.app.accessor.get(IStateService).has(sessionKey)).toBe(false);
  });

  it('resolves the same instance within one scope', () => {
    const session = host.child(LifecycleScope.Session, 's1');
    expect(session.accessor.get(ISessionStateService)).toBe(session.accessor.get(ISessionStateService));
  });
});
