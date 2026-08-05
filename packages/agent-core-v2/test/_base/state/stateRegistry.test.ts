import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import { BugIndicatingError } from '#/_base/errors/errors';
import { defineState, StateRegistry, type StateChange } from '#/_base/state/stateRegistry';
import { IAppStateService } from '#/app/state/appState';
import { AppStateService } from '#/app/state/appStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
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

  it('snapshots Maps as plain objects and Sets as arrays', () => {
    const richKey = defineState('test.rich', () => ({
      map: new Map([['a', 1]]),
      set: new Set(['x', 'y']),
      list: [1, 2],
      flag: true,
    }));
    const registry = new StateRegistry();
    registry.register(richKey);
    expect(registry.snapshot()).toEqual({
      'test.rich': { map: { a: 1 }, set: ['x', 'y'], list: [1, 2], flag: true },
    });
  });

  it('snapshots non-string-keyed Maps as entry arrays', () => {
    const id = { id: 1 };
    const pairKey = defineState('test.pairs', () => new Map<object, string>([[id, 'one']]));
    const registry = new StateRegistry();
    registry.register(pairKey);
    expect(registry.snapshot()).toEqual({ 'test.pairs': [[{ id: 1 }, 'one']] });
  });

  it('drops functions and marks circular references in snapshots', () => {
    const trickyKey = defineState('test.tricky', () => {
      const obj: Record<string, unknown> = { fn: () => 1, value: 2 };
      obj['self'] = obj;
      return obj;
    });
    const registry = new StateRegistry();
    registry.register(trickyKey);
    expect(registry.snapshot()).toEqual({
      'test.tricky': { value: 2, self: '(circular)' },
    });
  });

  it('shares referenced objects across branches without false circular marks', () => {
    const shared = { v: 1 };
    const sharedKey = defineState('test.shared', () => ({ a: shared, b: shared }));
    const registry = new StateRegistry();
    registry.register(sharedKey);
    expect(registry.snapshot()).toEqual({ 'test.shared': { a: { v: 1 }, b: { v: 1 } } });
  });

  it('collapses class instances to a marker in snapshots but keeps recursing plain data', () => {
    class FakeService {
      constructor(readonly dep: object) {}
    }
    // A resource graph reachable from plain data: plain -> class -> plain…
    // The class boundary stops the walk, so the deep plain tail never copied.
    const service = new FakeService({ deep: { tail: 'unreachable' } });
    const mixedKey = defineState('test.mixed', () => ({
      plain: { nested: [1, { ok: true }] },
      controller: new AbortController(),
      tool: service,
      nullProto: Object.assign(Object.create(null) as Record<string, unknown>, { v: 1 }),
    }));
    const registry = new StateRegistry();
    registry.register(mixedKey);
    expect(registry.snapshot()).toEqual({
      'test.mixed': {
        plain: { nested: [1, { ok: true }] },
        controller: '(AbortController)',
        tool: '(FakeService)',
        nullProto: { v: 1 },
      },
    });
  });
});

describe('state services (scoped)', () => {
  let host: ScopedTestHost;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IAppStateService,
      AppStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceStateService,
      WorkspaceStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgentStateService,
      AgentStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    host = createScopedTestHost();
  });

  afterEach(() => host.dispose());

  function createChain() {
    const workspace = host.child(LifecycleScope.Workspace, 'w1');
    const session = host.childOf(workspace, LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');
    return { workspace, session, agent };
  }

  it('resolves a distinct state service per scope tier', () => {
    const appState = host.app.accessor.get(IAppStateService);
    const { workspace, session, agent } = createChain();
    const workspaceState = workspace.accessor.get(IWorkspaceStateService);
    const sessionState = session.accessor.get(ISessionStateService);
    const agentState = agent.accessor.get(IAgentStateService);
    expect(appState).not.toBe(workspaceState);
    expect(workspaceState).not.toBe(sessionState);
    expect(sessionState).not.toBe(agentState);
  });

  it('keeps registered state invisible to sibling scope tiers', () => {
    const sessionKey = defineState('test.sessionOnly', () => 'seed');
    const { workspace, session, agent } = createChain();
    const sessionState = session.accessor.get(ISessionStateService);
    sessionState.register(sessionKey);
    sessionState.set(sessionKey, 'live');
    expect(sessionState.get(sessionKey)).toBe('live');
    expect(agent.accessor.get(IAgentStateService).has(sessionKey)).toBe(false);
    expect(workspace.accessor.get(IWorkspaceStateService).has(sessionKey)).toBe(false);
    expect(host.app.accessor.get(IAppStateService).has(sessionKey)).toBe(false);
  });

  it('resolves the same instance within one scope', () => {
    const { session } = createChain();
    expect(session.accessor.get(ISessionStateService)).toBe(session.accessor.get(ISessionStateService));
  });

  it('omits the parent link when a registry has no cascade parent', () => {
    const loneKey = defineState('test.lone', () => 0);
    const registry = new StateRegistry();
    registry.register(loneKey);
    expect(registry.inspect()).toEqual({
      scope: 'unknown',
      state: { 'test.lone': 0 },
      parent: undefined,
    });
  });

  it('cascades inspect from the agent tier up to the app root', () => {
    const appKey = defineState('test.appOnly', () => 'a');
    const workspaceKey = defineState('test.workspaceOnly', () => 'w');
    const sessionKey = defineState('test.sessionCascade', () => 's');
    const agentKey = defineState('test.agentOnly', () => 'g');
    host.app.accessor.get(IAppStateService).register(appKey);
    const { workspace, session, agent } = createChain();
    workspace.accessor.get(IWorkspaceStateService).register(workspaceKey);
    session.accessor.get(ISessionStateService).register(sessionKey);
    const agentState = agent.accessor.get(IAgentStateService);
    agentState.register(agentKey);

    expect(agentState.inspect()).toEqual({
      scope: 'agent',
      state: { 'test.agentOnly': 'g' },
      parent: {
        scope: 'session',
        state: { 'test.sessionCascade': 's' },
        parent: {
          scope: 'workspace',
          state: { 'test.workspaceOnly': 'w' },
          parent: {
            scope: 'app',
            state: { 'test.appOnly': 'a' },
            parent: undefined,
          },
        },
      },
    });
  });
});
