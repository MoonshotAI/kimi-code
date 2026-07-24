import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from '#/session/btw/btw';
import { SessionBtwService } from '#/session/btw/btwService';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';

describe('SessionBtwService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fork: ReturnType<typeof vi.fn>;
  let appendSystemReminder: ReturnType<typeof vi.fn>;
  let formatDenyMessage: ReturnType<typeof vi.fn>;
  let executorEvents: ToolExecutorEventStubs;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendSystemReminder = vi.fn();
    // The suffix mimics the worker-rejection guidance formatDenyMessage appends
    // for forked sub agents, so the assertion proves the reason went through it.
    formatDenyMessage = vi.fn((message: string) => `${message} [worker guidance]`);
    executorEvents = stubToolExecutorEvents();

    const child = {
      id: 'agent-btw-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentSystemReminderService) return { appendSystemReminder };
          if (id === IAgentToolApprovalService) return { formatDenyMessage };
          if (id === IAgentToolExecutorService) return executorEvents.executor;
          return undefined;
        },
      },
    };
    fork = vi.fn(async () => child);
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
    } as unknown as IAgentLifecycleService);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });
  afterEach(() => disposables.dispose());

  it('forks main and configures a side-question child agent', async () => {
    const svc = ix.get(ISessionBtwService);
    const id = await svc.start();

    expect(id).toBe('agent-btw-1');
    expect(fork).toHaveBeenCalledWith('main');
    expect(appendSystemReminder).toHaveBeenCalledWith(SIDE_QUESTION_SYSTEM_REMINDER, {
      kind: 'system_trigger',
      name: 'btw',
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
