import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { IRestGateway } from '#/app/gateway/gateway';
import { RestGateway } from '#/app/gateway/gatewayService';
import { stubAgentContext } from '../../agent/agentContext/stubs';
import { ILogService } from '#/_base/log/log';
import { AgentPrompt } from '#/actor/prompt/promptAgentRuntime';
import type { PromptRuntime } from '#/actor/prompt/prompt';
import { stubPromptRuntime } from '../../actor/prompt/stubs';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { LoopControl } from '#/actor/loop/internal/loop';
import { registerLoopControl } from '#/actor/loop/internal/access';
import { stubLog } from '../../_base/log/stubs';
import { stubLoopWithHooks, type StubLoop } from '../../agent/loop/stubs';
const LifecycleScope = { App: 'app', Session: 'session', Agent: 'agent' } as const;

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
  let turnService: StubLoop;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    promptCalls = [];
    turnService = stubLoopWithHooks({ hasActiveTurn: true });

    const promptRuntime: PromptRuntime = stubPromptRuntime({
      enqueue: ({ message }) => {
        promptCalls.push(message);
        return Promise.resolve({
          id: 'p',
          userMessageId: 'p',
          createdAt: new Date(0).toISOString(),
          state: 'running',
          message,
          launched: Promise.resolve(undefined),
          completion: Promise.resolve({ promptId: 'p', result: undefined, state: 'completed' }),
        });
      },
    });

    const agentContext = stubAgentContext('main', 1);
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      onDidCreate: () => ({ dispose: () => {} }),
      onWillClose: () => ({ dispose: () => {} }),
      onDidClose: () => ({ dispose: () => {} }),
      create: () => Promise.resolve(agentContext),
      fork: () => Promise.resolve(agentContext),
      get: (agentId: string) => (agentId === 'main' ? agentContext : undefined),
      list: () => [agentContext],
      resolve: (_agent: unknown, definition: unknown) => {
        if (definition === AgentPrompt) return promptRuntime;
        throw new Error('not supported in this test');
      },
      inspect: () => {
        throw new Error('not supported in this test');
      },
      remove: () => Promise.resolve(),
      broadcastPermissionMode: () => {},
      attachRuntimes: () => {},
    } as unknown as IAgentLifecycleService;
    registerLoopControl(agentContext, turnService as unknown as LoopControl, () => ({ nextTurnId: 0, cancelledTurnIds: [] }));
    const sessionHandle: ISessionScopeHandle = {
      id: 's1',
      kind: LifecycleScope.Session,
      accessor: makeAccessor([[IAgentLifecycleService, agents]]),
      dispose: () => {},
    };

    const sessionLifecycle: ISessionLifecycleService = {
      _serviceBrand: undefined,
      onWillCreateSession: () => ({ dispose: () => {} }),
      onDidCreateSession: () => ({ dispose: () => {} }),
      onWillCloseSession: () => ({ dispose: () => {} }),
      onDidCloseSession: () => ({ dispose: () => {} }),
      onDidArchiveSession: () => ({ dispose: () => {} }),
      onDidForkSession: () => ({ dispose: () => {} }),
      create: () => Promise.resolve(sessionHandle),
      get: (id: string) => (id === 's1' ? sessionHandle : undefined),
      list: () => [sessionHandle],
      resume: () => Promise.resolve(sessionHandle),
      close: () => Promise.resolve(),
      archive: () => Promise.resolve(),
      restore: () => Promise.resolve(sessionHandle),
      delete: () => Promise.resolve(),
      fork: () => Promise.resolve(sessionHandle),
      createChild: () => Promise.resolve(sessionHandle),
    };
    const handlerHandle = {
      id: 'wd_stub',
      kind: 'program',
      accessor: makeAccessor([[ISessionLifecycleService, sessionLifecycle]]),
      dispose: () => {},
    } as const;
    ix.stub(ISessionManager, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(sessionHandle),
      resume: () => Promise.resolve(sessionHandle),
      get: (id: string) => (id === 's1' ? sessionHandle : undefined),
      list: () => [sessionHandle],
      close: () => Promise.resolve(),
      archive: () => Promise.resolve(),
      restore: () => Promise.resolve(sessionHandle),
      delete: () => Promise.resolve(),
      fork: () => Promise.resolve(sessionHandle),
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
    const turn = turnService.startTurn();
    await gw.cancel('s1', 'main', 'bye');

    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe('bye');
  });
});
