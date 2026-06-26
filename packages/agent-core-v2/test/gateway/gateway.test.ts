import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import type { ContextMessage } from '#/contextMemory';
import { IRestGateway, IScopeRegistry } from '#/gateway';
import { RestGateway, ScopeRegistry } from '#/gateway/gatewayService';
import { ILogService } from '#/log';
import { IPromptService } from '#/prompt';
import { ITurnService } from '#/turn';
import { stubLog } from '../log/stubs';
import { stubTurn } from '../turn/stubs';

function textOf(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

function makeAccessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`unexpected service request: ${String(id)}`);
    },
  };
}

describe('ScopeRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IScopeRegistry, new SyncDescriptor(ScopeRegistry));
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
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let promptCalls: ContextMessage[];
  let cancelCalls: Array<{ turnId?: number; reason?: unknown }>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    promptCalls = [];
    cancelCalls = [];

    const promptService: IPromptService = {
      prompt: (message) => {
        promptCalls.push(message);
        return undefined;
      },
      steer: () => undefined,
      retry: () => undefined,
      undo: () => 0,
      clear: () => {},
    };
    const turnService: ITurnService = {
      ...stubTurn(),
      cancel: (turnId, reason) => {
        cancelCalls.push({ turnId, reason });
      },
    };

    const agentHandle: IScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: makeAccessor([
        [IPromptService, promptService],
        [ITurnService, turnService],
      ]),
    };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      create: () => Promise.resolve(agentHandle),
      createMain: () => Promise.resolve(agentHandle),
      getHandle: (id) => (id === 'main' ? agentHandle : undefined),
      list: () => [agentHandle],
      remove: () => Promise.resolve(),
    };
    const sessionHandle: IScopeHandle = {
      id: 's1',
      kind: LifecycleScope.Session,
      accessor: makeAccessor([[IAgentLifecycleService, agents]]),
    };

    ix.stub(IScopeRegistry, {
      _serviceBrand: undefined,
      createSession: () => Promise.resolve(sessionHandle),
      get: (id) => (id === 's1' ? sessionHandle : undefined),
      close: () => Promise.resolve(),
    });
    ix.stub(ILogService, stubLog());
    ix.set(IRestGateway, new SyncDescriptor(RestGateway));
  });
  afterEach(() => disposables.dispose());

  it('routes prompt to the agent prompt service', async () => {
    const gw = ix.get(IRestGateway);
    await gw.prompt('s1', 'main', 'hello');

    expect(promptCalls).toHaveLength(1);
    expect(textOf(promptCalls[0]!)).toBe('hello');
    expect(promptCalls[0]!.origin).toMatchObject({ kind: 'user' });
  });

  it('routes cancel to the agent turn service', async () => {
    const gw = ix.get(IRestGateway);
    await gw.cancel('s1', 'main', 'bye');

    expect(cancelCalls).toEqual([{ turnId: undefined, reason: 'bye' }]);
  });
});
