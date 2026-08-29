import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import type { ToolCallBlockData } from '#/tui/types';

function makeHarness() {
  const activeCalls = new Map<string, ToolCallBlockData>();
  const streamingUI = {
    setTurnId: vi.fn(),
    flushNow: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    registerToolCall: vi.fn((call: ToolCallBlockData) => {
      activeCalls.set(call.id, call);
      return true;
    }),
    completeToolResult: vi.fn((toolCallId: string) => {
      const call = activeCalls.get(toolCallId);
      activeCalls.delete(toolCallId);
      return call;
    }),
    setTodoList: vi.fn(),
  };
  const host = {
    state: {
      appState: { availableModels: {}, workDir: '/tmp/work', stepRetry: null },
      ui: { requestRender: vi.fn() },
      transcriptContainer: { addChild: vi.fn() },
    },
    session: undefined,
    streamingUI,
    appendTranscriptEntry: vi.fn(),
    patchLivePane: vi.fn(),
    setAppState: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    updateActivityPane: vi.fn(),
    showStatus: vi.fn(),
  };
  const handler = new SessionEventHandler(host as never);
  return { handler, streamingUI };
}

function todoCallStarted(toolCallId: string, todos: unknown): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'tool.call.started',
    turnId: 1,
    toolCallId,
    name: 'TodoList',
    args: { todos },
  } as unknown as Event;
}

function todoResult(toolCallId: string, isError = false): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'tool.result',
    turnId: 1,
    toolCallId,
    output: 'ok',
    isError,
  } as unknown as Event;
}

describe('SessionEventHandler — todo panel feed', () => {
  it('feeds the panel from TodoList call args when the tool result arrives', () => {
    const { handler, streamingUI } = makeHarness();
    const todos = [{ title: '测试 Todo 项', status: 'in_progress' }];

    handler.handleEvent(todoCallStarted('tc-1', todos), vi.fn());
    expect(streamingUI.setTodoList).not.toHaveBeenCalled();

    handler.handleEvent(todoResult('tc-1'), vi.fn());
    expect(streamingUI.setTodoList).toHaveBeenCalledWith(todos);
  });

  it('ignores failed TodoList results', () => {
    const { handler, streamingUI } = makeHarness();

    handler.handleEvent(todoCallStarted('tc-1', [{ title: 'x', status: 'pending' }]), vi.fn());
    handler.handleEvent(todoResult('tc-1', true), vi.fn());

    expect(streamingUI.setTodoList).not.toHaveBeenCalled();
  });
});
