import { describe, expect, it } from 'vitest';

import { InstantiationService } from '#/_base/di/instantiationService';
import type { Event } from '#/_base/event';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';
import type { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import type {
  ITurnService,
  TurnEndEvent,
  TurnStartEvent,
  TurnStepEvent,
  TurnToolEvent,
} from '#/turn/turn';

import { RestGateway, ScopeRegistry } from '#/gateway/gatewayService';

const noneEvent = (<T>(): Event<T> => () => ({ dispose: () => {} }))();

describe('ScopeRegistry', () => {
  it('createSession / get / close', async () => {
    const reg = new ScopeRegistry(new InstantiationService());
    const h = await reg.createSession({ sessionId: 's1', workDir: '/tmp' });
    expect(h.id).toBe('s1');
    expect(reg.get('s1')).toBe(h);
    await reg.close('s1');
    expect(reg.get('s1')).toBeUndefined();
  });
});

describe('RestGateway', () => {
  it('routes prompt to the agent turn service', async () => {
    const prompts: string[] = [];
    const turn: ITurnService = {
      _serviceBrand: undefined,
      onWillStartTurn: noneEvent as Event<TurnStartEvent>,
      onWillExecuteTool: noneEvent as Event<TurnToolEvent>,
      onDidFinalizeTool: noneEvent as Event<TurnToolEvent>,
      onDidEndStep: noneEvent as Event<TurnStepEvent>,
      onDidEndTurn: noneEvent as Event<TurnEndEvent>,
      get hasActiveTurn() {
        return false;
      },
      get currentId() {
        return undefined;
      },
      prompt: (input: string) => {
        prompts.push(input);
        return Promise.resolve();
      },
      steer: () => {},
      retry: () => Promise.resolve(),
      cancel: () => {},
    };
    const agentHandle: IScopeHandle = { id: 'main', kind: 2, accessor: { get: () => turn } as ServicesAccessor };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      create: () => Promise.resolve(agentHandle),
      createMain: () => Promise.resolve(agentHandle),
      getHandle: () => agentHandle,
      list: () => [agentHandle],
      remove: () => Promise.resolve(),
    };
    const sessionHandle: IScopeHandle = { id: 's1', kind: 1, accessor: { get: () => agents } as ServicesAccessor };
    const scopes = {
      _serviceBrand: undefined,
      createSession: () => Promise.resolve(sessionHandle),
      get: (id: string) => (id === 's1' ? sessionHandle : undefined),
      close: () => Promise.resolve(),
    };
    const gw = new RestGateway(scopes);
    await gw.prompt('s1', 'main', 'hello');
    expect(prompts).toEqual(['hello']);
  });
});
