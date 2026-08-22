import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import {
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from '#/features/btw/btw';
import { SessionBtwService } from '#/features/btw/btwService';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

describe('SessionBtwService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fork: ReturnType<typeof vi.fn>;
  let appendReminder: ReturnType<typeof vi.fn>;
  let formatDenyMessage: ReturnType<typeof vi.fn>;
  let executorEvents: ToolExecutorEventStubs;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendReminder = vi.fn(() => 'reminder-id');
    formatDenyMessage = vi.fn((message: string) => `${message} [worker guidance]`);
    executorEvents = stubToolExecutorEvents();

    const child = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentSystemReminderService) return { appendSystemReminder: appendReminder };
          if (id === IAgentToolApprovalService) return { formatDenyMessage };
          if (id === IAgentToolExecutorService) return executorEvents.executor;
          return undefined;
        },
      },
    };
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
    fork = vi.fn(async () => child);
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
      findAgentHandle: (id: string) => (id === 'main' ? main : undefined),
    } as unknown as IAgentLifecycleService);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });
  afterEach(() => disposables.dispose());

  it('forks main and configures a side-question child agent', async () => {
    const svc = ix.get(ISessionBtwService);
    const id = await svc.start();

    expect(id).toBe('agent-btw-1');
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main', generation: 1 }));
    expect(appendReminder).toHaveBeenCalledWith(SIDE_QUESTION_SYSTEM_REMINDER, {
      kind: 'injection',
      variant: 'btw',
    });
  });

  it('vetoes every tool call on the child through the btw deny listener', async () => {
    const svc = ix.get(ISessionBtwService);
    await svc.start();

    const toolCall: ToolCall = { type: 'function', id: 'call_1', name: 'Bash', arguments: '{}' };
    const decision = await executorEvents.fireBeforeExecute({
      turnId: 0,
      signal: new AbortController().signal,
      toolCall,
      toolCalls: [toolCall],
      args: {},
      execution: { approvalRule: 'Bash', execute: async () => ({ output: '' }) },
    });

    expect(decision).toEqual({
      veto: {
        output: `${TOOL_CALL_DISABLED_MESSAGE} [worker guidance]`,
        isError: true,
      },
    });
    expect(formatDenyMessage).toHaveBeenCalledWith(TOOL_CALL_DISABLED_MESSAGE);
  });
});
