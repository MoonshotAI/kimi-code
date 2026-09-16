import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { ISessionEventBus } from '#/app/event/eventBus';
import type { IFlagService } from '#/app/flag/flag';
import { AgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { RuntimeBinding } from '#/runtime/runtime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { AgentWorkspaceContextService } from '#/session/workspaceContext/agentWorkspaceContextService';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { stubAgentContext } from '../../agent/agentContext/stubs';

interface AgentHarness {
  readonly shadow: AgentWorkspaceContextService;
  readonly binding: IAgentRuntimeBindingService & { apply(next: RuntimeBinding): void };
  readonly publishBus: (type: string, event: { readonly agentId?: string }) => void;
}

function setup(options: { readonly flagOn?: boolean; readonly sessionCwd?: string } = {}) {
  const registry = new RuntimeRegistry('workspace');
  registry.register(Object.assign(new FakeRuntime(
    { workspaceId: 'workspace', runtimeId: 'local', generation: 'local-one' },
    { capabilities: ['fs', 'process'] },
  ), { fs: {}, process: {} }));
  registry.register(Object.assign(new FakeRuntime(
    { workspaceId: 'workspace', runtimeId: 'remote', generation: 'remote-one' },
    { capabilities: ['fs', 'process'] },
  ), { fs: {}, process: {} }));
  const sessionState = new SessionStateService();
  sessionState.contributeState(workspaceContextWorkDirKey);
  sessionState.contributeState(workspaceContextAdditionalDirsKey);
  const sessionCwd = options.sessionCwd ?? '/workspace';
  sessionState.set(workspaceContextWorkDirKey, sessionCwd);
  sessionState.set(workspaceContextAdditionalDirsKey, ['/extra']);
  const session = makeSessionContext({
    sessionId: 'session',
    workspaceId: 'workspace',
    sessionDir: '/session',
    sessionScope: 'sessions/session',
    cwd: sessionCwd,
  });
  let flagOn = options.flagOn ?? false;
  const flags = { _serviceBrand: undefined, enabled: () => flagOn } as unknown as IFlagService;
  const workspaces = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    get: () => ({ runtimes: registry }),
  } as unknown as IWorkspaceInstanceManager;
  const busHandlers = new Map<string, ((event: { readonly agentId?: string }) => void)[]>();
  const eventBus = {
    subscribe: (cls: { readonly type: string }, handler: (event: { readonly agentId?: string }) => void) => {
      const handlers = busHandlers.get(cls.type) ?? [];
      handlers.push(handler);
      busHandlers.set(cls.type, handlers);
      return { dispose: () => {} };
    },
  } as unknown as ISessionEventBus;
  const publishBus = (type: string, event: { readonly agentId?: string }): void => {
    for (const handler of busHandlers.get(type) ?? []) handler(event);
  };

  function agent(agentId: string, initial: RuntimeBinding): AgentHarness {
    const bindingEmitter = new Emitter<RuntimeBinding>();
    let current = initial;
    const binding = {
      _serviceBrand: undefined,
      onDidChange: bindingEmitter.event,
      get current() {
        return current;
      },
      get: () => current,
      apply(next: RuntimeBinding) {
        current = next;
        bindingEmitter.fire(next);
      },
    } as unknown as IAgentRuntimeBindingService & { apply(next: RuntimeBinding): void };
    const scopeContext = {
      _serviceBrand: undefined,
      agentId,
      agentContext: stubAgentContext(agentId, 1),
      scope: (subKey?: string) => subKey ?? '',
    };
    const runtime = new AgentRuntimeService(scopeContext, binding, {
      _serviceBrand: undefined,
      inspect: (b: RuntimeBinding) => registry.inspect(b),
      acquire: (b: RuntimeBinding, required?: never) => registry.acquire(b, required),
    }, workspaces, eventBus, session, sessionState, flags);
    const shadow = new AgentWorkspaceContextService(sessionState, {
      current: runtime,
      onDidChange: () => ({ dispose: () => {} }),
    });
    return { shadow, binding, publishBus };
  }

  return {
    agent,
    sessionState,
    setFlagOn: (value: boolean) => {
      flagOn = value;
    },
  };
}

describe('AgentWorkspaceContextService', () => {
  it('passes the shared session workDir through when the flag is off', () => {
    const { agent, sessionState } = setup({ flagOn: false });
    const main = agent('main', { workspaceId: 'workspace', runtimeId: 'local' });

    expect(main.shadow.workDir).toBe('/workspace');
    expect(main.shadow.additionalDirs).toEqual(['/extra']);

    sessionState.set(workspaceContextWorkDirKey, '/switched');
    expect(main.shadow.workDir).toBe('/switched');

    main.binding.apply({ workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });
    expect(main.shadow.workDir).toBe('/switched');
    expect(main.shadow.additionalDirs).toEqual(['/extra']);
  });

  it('derives the workDir from each agent binding when the flag is on', () => {
    const { agent } = setup({ flagOn: true });
    const main = agent('main', { workspaceId: 'workspace', runtimeId: 'local' });
    const sub = agent('agent-1', { workspaceId: 'workspace', runtimeId: 'local' });

    expect(main.shadow.workDir).toBe('/workspace');

    main.binding.apply({ workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });
    expect(main.shadow.workDir).toBe('/remote/work');
    expect(main.shadow.additionalDirs).toEqual([]);

    expect(sub.shadow.workDir).toBe('/workspace');
    expect(sub.shadow.additionalDirs).toEqual(['/extra']);
  });

  it('keeps a sub-agent on its own inherited binding cwd after the main agent switches', () => {
    const { agent } = setup({ flagOn: true });
    const main = agent('main', { workspaceId: 'workspace', runtimeId: 'local', cwd: '/workspace' });
    const sub = agent('agent-1', { workspaceId: 'workspace', runtimeId: 'local', cwd: '/workspace' });

    main.binding.apply({ workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });

    expect(main.shadow.workDir).toBe('/remote/work');
    expect(sub.shadow.workDir).toBe('/workspace');
  });

  it('pins the derived roots to the turn snapshot until the turn ends', () => {
    const { agent } = setup({ flagOn: true });
    const main = agent('main', { workspaceId: 'workspace', runtimeId: 'local' });

    main.publishBus('turn.started', { agentId: 'main' });
    main.binding.apply({ workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });
    expect(main.shadow.workDir).toBe('/workspace');

    main.publishBus('turn.ended', { agentId: 'main' });
    expect(main.shadow.workDir).toBe('/remote/work');
  });

  it('resolves and guards paths against the derived roots', () => {
    const { agent } = setup({ flagOn: true });
    const main = agent('main', { workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });

    expect(main.shadow.resolve('src/index.ts')).toBe('/remote/work/src/index.ts');
    expect(main.shadow.isWithin('/remote/work/src')).toBe(true);
    expect(main.shadow.isWithin('/elsewhere')).toBe(false);
    expect(() => main.shadow.assertAllowed('/elsewhere', 'read')).toThrowError(/outside workspace/);
  });

  it('keeps setWorkDir writing the shared session state', () => {
    const { agent, sessionState } = setup({ flagOn: true });
    const main = agent('main', { workspaceId: 'workspace', runtimeId: 'local' });

    main.shadow.setWorkDir('/pushed');
    expect(sessionState.get(workspaceContextWorkDirKey)).toBe('/pushed');
  });
});
