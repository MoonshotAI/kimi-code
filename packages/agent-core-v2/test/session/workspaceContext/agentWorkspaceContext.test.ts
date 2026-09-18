import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { ISessionEventBus } from '#/app/event/eventBus';
import { AgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import type { EnvironmentBinding } from '#/environment/environment';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { fakeEnvironment } from '../../environment/stubs';
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
  readonly binding: IAgentEnvironmentBindingService & { apply(next: EnvironmentBinding): void };
  readonly publishBus: (type: string, event: { readonly agentId?: string }) => void;
}

function setup(options: { readonly sessionCwd?: string } = {}) {
  const registry = new EnvironmentRegistry('workspace');
  registry.register(fakeEnvironment('local', 'local-one'));
  registry.register(fakeEnvironment('remote', 'remote-one'));
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
  const workspaces = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    get: () => ({ environments: registry }),
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

  function agent(agentId: string, initial: EnvironmentBinding): AgentHarness {
    const bindingEmitter = new Emitter<EnvironmentBinding>();
    let current = initial;
    const binding = {
      _serviceBrand: undefined,
      onDidChange: bindingEmitter.event,
      get current() {
        return current;
      },
      get: () => current,
      apply(next: EnvironmentBinding) {
        current = next;
        bindingEmitter.fire(next);
      },
    } as unknown as IAgentEnvironmentBindingService & { apply(next: EnvironmentBinding): void };
    const scopeContext = {
      _serviceBrand: undefined,
      agentId,
      agentContext: stubAgentContext(agentId, 1),
      scope: (subKey?: string) => subKey ?? '',
    };
    const environment = new AgentEnvironmentService(scopeContext, binding, {
      _serviceBrand: undefined,
      inspect: (b: EnvironmentBinding) => registry.inspect(b),
      acquire: (b: EnvironmentBinding, required?: never) => registry.acquire(b, required),
      acquireWhenReady: (b: EnvironmentBinding, required?: never) => registry.acquireWhenReady(b, required),
    }, workspaces, eventBus, session, sessionState);
    const shadow = new AgentWorkspaceContextService(sessionState, {
      current: environment,
      onDidChange: () => ({ dispose: () => {} }),
    });
    return { shadow, binding, publishBus };
  }

  return {
    agent,
    sessionState,
  };
}

describe('AgentWorkspaceContextService', () => {
  it('derives the workDir from each agent binding', () => {
    const { agent } = setup();
    const main = agent('main', { workspaceId: 'workspace', environmentId: 'local' });
    const sub = agent('agent-1', { workspaceId: 'workspace', environmentId: 'local' });

    expect(main.shadow.workDir).toBe('/workspace');

    main.binding.apply({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
    expect(main.shadow.workDir).toBe('/remote/work');
    expect(main.shadow.additionalDirs).toEqual([]);

    expect(sub.shadow.workDir).toBe('/workspace');
    expect(sub.shadow.additionalDirs).toEqual(['/extra']);
  });

  it('keeps a sub-agent on its own inherited binding cwd after the main agent switches', () => {
    const { agent } = setup();
    const main = agent('main', { workspaceId: 'workspace', environmentId: 'local', cwd: '/workspace' });
    const sub = agent('agent-1', { workspaceId: 'workspace', environmentId: 'local', cwd: '/workspace' });

    main.binding.apply({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });

    expect(main.shadow.workDir).toBe('/remote/work');
    expect(sub.shadow.workDir).toBe('/workspace');
  });

  it('pins the derived roots to the turn snapshot until the turn ends', () => {
    const { agent } = setup();
    const main = agent('main', { workspaceId: 'workspace', environmentId: 'local' });

    main.publishBus('turn.started', { agentId: 'main' });
    main.binding.apply({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
    expect(main.shadow.workDir).toBe('/workspace');

    main.publishBus('turn.ended', { agentId: 'main' });
    expect(main.shadow.workDir).toBe('/remote/work');
  });

  it('resolves and guards paths against the derived roots', () => {
    const { agent } = setup();
    const main = agent('main', { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });

    expect(main.shadow.resolve('src/index.ts')).toBe('/remote/work/src/index.ts');
    expect(main.shadow.isWithin('/remote/work/src')).toBe(true);
    expect(main.shadow.isWithin('/elsewhere')).toBe(false);
    expect(() => main.shadow.assertAllowed('/elsewhere', 'read')).toThrowError(/outside workspace/);
  });

  it('keeps setWorkDir writing the shared session state', () => {
    const { agent, sessionState } = setup();
    const main = agent('main', { workspaceId: 'workspace', environmentId: 'local' });

    main.shadow.setWorkDir('/pushed');
    expect(sessionState.get(workspaceContextWorkDirKey)).toBe('/pushed');
  });
});
