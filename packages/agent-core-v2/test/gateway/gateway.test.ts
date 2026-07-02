import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, type ISessionScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ContextMessage } from '#/agent/contextMemory';
import { IRestGateway } from '#/app/gateway';
import { RestGateway } from '#/app/gateway/gatewayService';
import { ILogService } from '#/app/log';
import { IAgentPromptService } from '#/agent/prompt';
import { ISessionLifecycleService } from '#/app/sessionLifecycle';
import { IAgentTurnService } from '#/agent/turn';
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

describe('RestGateway', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let promptCalls: ContextMessage[];
  let turnService: IAgentTurnService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    promptCalls = [];
    turnService = stubTurn({ hasActiveTurn: true });

    const promptService: IAgentPromptService = {
      _serviceBrand: undefined,
      prompt: (message) => {
        promptCalls.push(message);
        return undefined;
      },
      steer: () => undefined,
      retry: () => undefined,
      undo: () => 0,
      clear: () => {},
    };

    const agentHandle: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: makeAccessor([
        [IAgentPromptService, promptService],
        [IAgentTurnService, turnService],
      ]),
      dispose: () => {},
    };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
      create: () => Promise.resolve(agentHandle),
      createMain: () => Promise.resolve(agentHandle),
      clone: () => Promise.resolve(agentHandle),
      spawn: () => Promise.resolve(agentHandle),
      getHandle: (id) => (id === 'main' ? agentHandle : undefined),
      list: () => [agentHandle],
      remove: () => Promise.resolve(),
    };
    const sessionHandle: ISessionScopeHandle = {
      id: 's1',
      kind: LifecycleScope.Session,
      accessor: makeAccessor([[IAgentLifecycleService, agents]]),
      dispose: () => {},
    };

    ix.stub(ISessionLifecycleService, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(sessionHandle),
      get: (id) => (id === 's1' ? sessionHandle : undefined),
      list: () => [sessionHandle],
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

  it('aborts the active turn signal on cancel', async () => {
    const gw = ix.get(IRestGateway);
    const turn = turnService.launch({ kind: 'user' });
    await gw.cancel('s1', 'main', 'bye');

    expect(turn.abortController.signal.aborted).toBe(true);
    expect(turn.abortController.signal.reason).toBe('bye');
  });
});
