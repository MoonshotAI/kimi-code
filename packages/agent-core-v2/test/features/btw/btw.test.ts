import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import {
  BTW_AGENT_LABEL,
  BTW_READONLY_TOOLS,
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from '#/features/btw/btw';
import { SessionBtwService } from '#/features/btw/btwService';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ToolCall } from '#human/message';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { ErrorCodes, Error2 } from '#/errors';
import {
  IAgentLifecycleService,
  type AgentScopeCreatedEvent,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionErrors } from '#/session/errors';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

describe('SessionBtwService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fork: ReturnType<typeof vi.fn>;
  let acquire: ReturnType<typeof vi.fn>;
  let releaseLease: ReturnType<typeof vi.fn>;
  let appendReminder: ReturnType<typeof vi.fn>;
  let formatDenyMessage: ReturnType<typeof vi.fn>;
  let executorEvents: ToolExecutorEventStubs;
  let onDidCreateScope: Emitter<AgentScopeCreatedEvent>;
  let childContext: AgentContext;
  let child: AgentScopeCreatedEvent['handle'];

  function fireScopeCreated(
    handle: AgentScopeCreatedEvent['handle'],
    labels?: Readonly<Record<string, string>>,
  ): void {
    onDidCreateScope.fire({
      context: childContext,
      handle,
      meta: { type: 'sub', parentAgentId: 'main', forkedFrom: 'main', labels },
    });
  }

  function bashDecision(events: ToolExecutorEventStubs, name: string) {
    const toolCall: ToolCall = { type: 'function', id: `call_${name}`, name, arguments: '{}' };
    return events.fireBeforeExecute({
      turnId: 0,
      signal: new AbortController().signal,
      toolCall,
      toolCalls: [toolCall],
      args: {},
      execution: { approvalRule: name, execute: async () => ({ output: '' }) },
    });
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendReminder = vi.fn(() => 'reminder-id');
    formatDenyMessage = vi.fn((message: string) => `${message} [worker guidance]`);
    executorEvents = stubToolExecutorEvents();
    onDidCreateScope = disposables.add(new Emitter<AgentScopeCreatedEvent>());
    childContext = stubAgentContext('agent-btw-1', 2);

    child = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentToolApprovalService) return { formatDenyMessage };
          if (id === IAgentToolExecutorService) return executorEvents.executor;
          if (id === IAgentReminderService) return { notify: appendReminder };
          return undefined;
        },
      },
    } as unknown as AgentScopeCreatedEvent['handle'];
    const main = {
      id: 'main',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentScopeContext) {
            return {
              _serviceBrand: undefined,
              agentId: 'main',
              agentContext: stubAgentContext('main', 1),
              scope: (subKey?: string) => subKey ?? '',
            };
          }
          return undefined;
        },
      },
    };
    fork = vi.fn(async (_source: unknown, opts?: { labels?: Readonly<Record<string, string>> }) => {
      fireScopeCreated(child, opts?.labels);
      return childContext;
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
      onDidCreateScope: onDidCreateScope.event,
      get: (id: string) => (id === 'agent-btw-1' ? childContext : undefined),
      remove: vi.fn(async () => {}),
      handleOf: (id: string) => {
        if (id === 'main') return main;
        if (id === 'agent-btw-1') return child;
        return undefined;
      },
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      read: async () => ({ id: 's1', createdAt: 0, updatedAt: 0, archived: false, agents: {} }),
      unregisterAgent: vi.fn(async () => {}),
    } as unknown as ISessionMetadata);
    releaseLease = vi.fn();
    acquire = vi.fn(() => ({ release: releaseLease }));
    ix.stub(ISessionRunGate, {
      _serviceBrand: undefined,
      begin: vi.fn(),
      acquire,
      tryAcquire: vi.fn(),
    } as unknown as ISessionRunGate);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });
  afterEach(() => disposables.dispose());

  it('forks main with the btw label and configures a side-question child agent', async () => {
    const svc = ix.get(ISessionBtwService);
    const id = await svc.start();

    expect(id).toBe('agent-btw-1');
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main', generation: 1 }), {
      labels: { [BTW_AGENT_LABEL]: 'true' },
    });
    expect(appendReminder).toHaveBeenCalledWith(SIDE_QUESTION_SYSTEM_REMINDER, {
      variant: 'btw',
    });
  });

  it('holds the session run gate while forking and releases it afterwards', async () => {
    await ix.get(ISessionBtwService).start();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(fork.mock.invocationCallOrder[0]!);
    expect(fork.mock.invocationCallOrder[0]).toBeLessThan(releaseLease.mock.invocationCallOrder[0]!);
  });

  it('rejects with session.stale before forking when the session was updated by another client', async () => {
    acquire.mockImplementationOnce(() => {
      throw new Error2(SessionErrors.codes.SESSION_STALE, 'stale');
    });

    await expect(ix.get(ISessionBtwService).start()).rejects.toMatchObject({
      code: SessionErrors.codes.SESSION_STALE,
    });
    expect(fork).not.toHaveBeenCalled();
  });

  it('vetoes non-read-only tool calls on the child through the btw deny listener', async () => {
    const svc = ix.get(ISessionBtwService);
    await svc.start();

    for (const name of ['Bash', 'Write', 'Edit']) {
      const decision = await bashDecision(executorEvents, name);

      expect(decision).toEqual({
        veto: {
          output: `${TOOL_CALL_DISABLED_MESSAGE} [worker guidance]`,
          isError: true,
        },
      });
    }
    expect(formatDenyMessage).toHaveBeenCalledWith(TOOL_CALL_DISABLED_MESSAGE);
  });

  it('allows read-only tool calls (Read, Grep, Glob) on the child', async () => {
    const svc = ix.get(ISessionBtwService);
    await svc.start();

    for (const name of BTW_READONLY_TOOLS) {
      const decision = await bashDecision(executorEvents, name);

      expect(decision).toBeUndefined();
    }
  });

  it('re-attaches the read-only veto when a btw-labelled agent scope is recreated', async () => {
    ix.get(ISessionBtwService);
    const rebuiltEvents = stubToolExecutorEvents();
    const rebuilt = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentToolApprovalService) return { formatDenyMessage };
          if (id === IAgentToolExecutorService) return rebuiltEvents.executor;
          return undefined;
        },
      },
    } as unknown as AgentScopeCreatedEvent['handle'];

    fireScopeCreated(rebuilt, { [BTW_AGENT_LABEL]: 'true' });

    expect(await bashDecision(rebuiltEvents, 'Bash')).toEqual({
      veto: {
        output: `${TOOL_CALL_DISABLED_MESSAGE} [worker guidance]`,
        isError: true,
      },
    });
    expect(await bashDecision(rebuiltEvents, 'Read')).toBeUndefined();
  });

  it('leaves agent scopes without the btw label unrestricted', async () => {
    ix.get(ISessionBtwService);
    fireScopeCreated(child, undefined);
    fireScopeCreated(child, { parentAgentId: 'main' });

    expect(await bashDecision(executorEvents, 'Bash')).toBeUndefined();
  });

  it('closes a live btw agent even when persisted metadata omitted registration, unregistering before removal', async () => {
    const order: string[] = [];
    const liveBtwHandle = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentScopeContext) {
            return {
              _serviceBrand: undefined,
              agentId: 'agent-btw-1',
              agentContext: childContext,
              meta: { type: 'sub', labels: { [BTW_AGENT_LABEL]: 'true' } },
              scope: (subKey?: string) => subKey ?? '',
            };
          }
          return undefined;
        },
      },
    } as unknown as AgentScopeCreatedEvent['handle'];
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreateScope: onDidCreateScope.event,
      get: (id: string) => (id === 'agent-btw-1' ? childContext : undefined),
      handleOf: (id: string) => (id === 'agent-btw-1' ? liveBtwHandle : undefined),
      remove: vi.fn(async () => {
        order.push('remove');
      }),
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      read: async () => ({ id: 's1', createdAt: 0, updatedAt: 0, archived: false, agents: {} }),
      unregisterAgent: vi.fn(async () => {
        order.push('unregister');
      }),
    } as unknown as ISessionMetadata);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));

    await ix.get(ISessionBtwService).close('agent-btw-1');
    expect(order).toEqual(['unregister', 'remove']);
  });

  it('joins an in-progress close when a second close starts after metadata unregistration', async () => {
    let persistedAgents: Record<string, { type: 'sub'; labels: Record<string, string> }> = {
      'agent-btw-1': { type: 'sub', labels: { [BTW_AGENT_LABEL]: 'true' } },
    };
    let liveVisible = true;
    let releaseRemove!: () => void;
    const removeBarrier = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removeById = vi.fn(async () => {
      liveVisible = false;
      await removeBarrier;
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreateScope: onDidCreateScope.event,
      get: (id: string) => (id === 'agent-btw-1' && liveVisible ? childContext : undefined),
      handleOf: (id: string) => (id === 'agent-btw-1' && liveVisible ? child : undefined),
      removeById,
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      read: async () => ({ id: 's1', createdAt: 0, updatedAt: 0, archived: false, agents: persistedAgents }),
      unregisterAgent: vi.fn(async (id: string) => {
        const next = { ...persistedAgents };
        delete next[id];
        persistedAgents = next;
      }),
    } as unknown as ISessionMetadata);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));

    const svc = ix.get(ISessionBtwService);
    const first = svc.close('agent-btw-1');
    await vi.waitFor(() => expect(removeById).toHaveBeenCalledTimes(1));

    let secondSettled = false;
    const second = svc.close('agent-btw-1').then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseRemove();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(removeById).toHaveBeenCalledTimes(1);

    await expect(svc.close('agent-btw-1')).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_FOUND });
  });
});
