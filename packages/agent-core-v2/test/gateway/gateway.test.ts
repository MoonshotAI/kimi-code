import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IRestGateway, IScopeRegistry } from '#/gateway';
import { RestGateway, ScopeRegistry } from '#/gateway/gatewayService';
import { stubTurn } from '../turn/stubs';

describe('ScopeRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IScopeRegistry, ScopeRegistry);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('createSession / get / close', async () => {
    const reg = ix.get(IScopeRegistry);
    const h = await reg.createSession({ sessionId: 's1', workDir: '/tmp' });
    expect(h.id).toBe('s1');
    expect(reg.get('s1')).toBe(h);
    await reg.close('s1');
    expect(reg.get('s1')).toBeUndefined();
  });
});

describe('RestGateway', () => {
  it('routes prompt to the agent turn service', async () => {
    const disposables = new DisposableStore();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IRestGateway, RestGateway);
      },
    });

    const turn = stubTurn();
    const agentHandle: IScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: () => turn } as unknown as ServicesAccessor,
    };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      create: () => Promise.resolve(agentHandle),
      createMain: () => Promise.resolve(agentHandle),
      getHandle: () => agentHandle,
      list: () => [agentHandle],
      remove: () => Promise.resolve(),
    };
    const sessionHandle: IScopeHandle = {
      id: 's1',
      kind: LifecycleScope.Session,
      accessor: { get: () => agents } as unknown as ServicesAccessor,
    };
    ix.stub(IScopeRegistry, {
      _serviceBrand: undefined,
      createSession: () => Promise.resolve(sessionHandle),
      get: (id) => (id === 's1' ? sessionHandle : undefined),
      close: () => Promise.resolve(),
    });

    const gw = ix.get(IRestGateway);
    await gw.prompt('s1', 'main', 'hello');
    expect(turn.prompts).toEqual(['hello']);

    disposables.dispose();
  });
});
