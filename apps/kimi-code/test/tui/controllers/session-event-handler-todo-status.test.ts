import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { TurnTimeline } from '#/tui/utils/turn-timeline';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const streamingUI = {
    timeline: new TurnTimeline(),
    setTurnId: vi.fn(),
    flushNow: vi.fn(),
    resetToolUi: vi.fn(),
    clearNotifyPanel: vi.fn(),
    markNotifyPanelEnded: vi.fn(),
    setStep: vi.fn(),
    finalizeTurn: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    registerToolCall: vi.fn(),
    completeToolResult: vi.fn(),
  };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
        todos: null,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: {},
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI,
    requireSession: vi.fn(() => ({})),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    updateActivityPane: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
    surveyController: {
      notifyToolCallStarted: vi.fn(),
      notifyToolCallEnded: vi.fn(),
      notifySubagentSpawned: vi.fn(),
    },
  };
  return { host: host as any, streamingUI };
}

function toolResult(output: string, isError = false) {
  return {
    type: 'tool.result',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    toolCallId: 't1',
    output,
    isError,
  } as never;
}

function turnEnded() {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    reason: 'completed',
  } as never;
}

const WRITE_OUTPUT = [
  'Todo list updated.',
  'Current todo list:',
  '  [done] Read the code',
  '  [in_progress] Fix the footer',
  '',
].join('\n');

describe('SessionEventHandler — todo status line state', () => {
  it('stores the sanitized write args when TodoList updates the list', () => {
    const { host, streamingUI } = makeHost();
    streamingUI.completeToolResult.mockReturnValue({
      name: 'TodoList',
      args: {
        todos: [
          { title: 'Read the code', status: 'done' },
          { title: 'Fix the footer', status: 'in_progress' },
          { title: '', status: 'pending' },
          { title: 'No status' },
        ],
      },
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult(WRITE_OUTPUT), vi.fn());

    expect(host.state.appState.todos).toEqual([
      { title: 'Read the code', status: 'done' },
      { title: 'Fix the footer', status: 'in_progress' },
    ]);
  });

  it('clears the list when TodoList writes an empty list', () => {
    const { host, streamingUI } = makeHost();
    host.state.appState.todos = [{ title: 'Old', status: 'pending' }];
    streamingUI.completeToolResult.mockReturnValue({ name: 'TodoList', args: { todos: [] } });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult('Todo list updated.'), vi.fn());

    expect(host.state.appState.todos).toEqual([]);
  });

  it('parses the result output when TodoList only reads the list', () => {
    const { host, streamingUI } = makeHost();
    streamingUI.completeToolResult.mockReturnValue({ name: 'TodoList', args: {} });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult(WRITE_OUTPUT), vi.fn());

    expect(host.state.appState.todos).toEqual([
      { title: 'Read the code', status: 'done' },
      { title: 'Fix the footer', status: 'in_progress' },
    ]);
  });

  it('keeps the previous list when a read result carries no list', () => {
    const { host, streamingUI } = makeHost();
    const previous = [{ title: 'Old', status: 'pending' }];
    host.state.appState.todos = previous;
    streamingUI.completeToolResult.mockReturnValue({ name: 'TodoList', args: {} });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult('Todo list updated.'), vi.fn());

    expect(host.state.appState.todos).toBe(previous);
    expect(host.setAppState).not.toHaveBeenCalledWith(expect.objectContaining({ todos: expect.anything() }));
  });

  it('ignores errored TodoList results', () => {
    const { host, streamingUI } = makeHost();
    const previous = [{ title: 'Old', status: 'pending' }];
    host.state.appState.todos = previous;
    streamingUI.completeToolResult.mockReturnValue({
      name: 'TodoList',
      args: { todos: [{ title: 'New', status: 'done' }] },
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult('Invalid todo list', true), vi.fn());

    expect(host.state.appState.todos).toBe(previous);
  });

  it('ignores results from other tools', () => {
    const { host, streamingUI } = makeHost();
    streamingUI.completeToolResult.mockReturnValue({ name: 'Bash', args: {} });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult(WRITE_OUTPUT), vi.fn());

    expect(host.state.appState.todos).toBeNull();
  });

  it('clears a fully-done list when the turn ends', () => {
    const { host } = makeHost();
    host.state.appState.todos = [
      { title: 'Read the code', status: 'done' },
      { title: 'Fix the footer', status: 'done' },
    ];
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEnded(), vi.fn());

    expect(host.state.appState.todos).toBeNull();
  });

  it('keeps an active list across the turn boundary', () => {
    const { host } = makeHost();
    const active = [
      { title: 'Read the code', status: 'done' },
      { title: 'Fix the footer', status: 'in_progress' },
    ];
    host.state.appState.todos = active;
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEnded(), vi.fn());

    expect(host.state.appState.todos).toBe(active);
  });
});
