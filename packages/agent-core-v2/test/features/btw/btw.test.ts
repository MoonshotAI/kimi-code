import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { AgentTools } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import {
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from '#/features/btw/btw';
import { SessionBtwService } from '#/features/btw/btwService';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../toolExecutor/stubs';
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

    fork = vi.fn(async () => stubAgentContext('agent-btw-1', 2));
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
      get: (agentId: string) =>
        agentId === MAIN_AGENT_ID ? stubAgentContext(MAIN_AGENT_ID, 1) : undefined,
      resolve: (_agent: unknown, definition: unknown) => {
        if (definition === AgentTools) return executorEvents.executor;
        return { notify: appendReminder };
      },
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionToolApprovalService, {
      _serviceBrand: undefined,
      of: () => ({ formatDenyMessage }),
    } as unknown as ISessionToolApprovalService);
    ix.set(ISessionBtwService, new SyncDescriptor(SessionBtwService));
  });
  afterEach(() => disposables.dispose());

  it('forks main and configures a side-question child agent', async () => {
    const svc = ix.get(ISessionBtwService);
    const id = await svc.start();

    expect(id).toBe('agent-btw-1');
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main', generation: 1 }));
    expect(appendReminder).toHaveBeenCalledWith(SIDE_QUESTION_SYSTEM_REMINDER, {
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
