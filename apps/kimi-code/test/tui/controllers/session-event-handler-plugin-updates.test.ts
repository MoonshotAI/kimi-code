import { describe, expect, it, vi } from 'vitest';

import type { PluginUpdateNotifier } from '#/tui/controllers/plugin-update-notifier';
import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

const DATASOURCE_TOOL = 'mcp__plugin-kimi-datasource_data__call_data_source_tool';

function makeHost() {
  const streamingUI = {
    setTurnId: vi.fn(),
    flushNow: vi.fn(),
    resetToolUi: vi.fn(),
    setStep: vi.fn(),
    finalizeTurn: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    registerToolCall: vi.fn(),
    completeToolResult: vi.fn(),
    setTodoList: vi.fn(),
  };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: {},
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI,
    requireSession: vi.fn(() => ({})),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    updateActivityPane: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as never, streamingUI };
}

function makeNotifier() {
  return {
    handleMcpToolCompleted: vi.fn(),
    handlePluginCommandCompleted: vi.fn(),
  };
}

function toolCallStarted(name: string) {
  return {
    type: 'tool.call.started',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    toolCallId: 't1',
    name,
    args: {},
  } as never;
}

function toolResult() {
  return {
    type: 'tool.result',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    toolCallId: 't1',
    output: 'ok',
  } as never;
}

function turnEnded(reason: string, turnId = 1) {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId,
    reason,
  } as never;
}

function pluginCommandTurnStarted() {
  return {
    type: 'turn.started',
    sessionId: 's1',
    agentId: 'main',
    turnId: 2,
    origin: {
      kind: 'plugin_command',
      activationId: 'a1',
      pluginId: 'kimi-datasource',
      commandName: 'setup',
      trigger: 'user-slash',
    },
  } as never;
}

const sendQueued = (): void => {};

describe('SessionEventHandler plugin update notices', () => {
  it('reports plugin MCP usage only when the turn ends', () => {
    const { host, streamingUI } = makeHost();
    const notifier = makeNotifier();
    streamingUI.completeToolResult.mockReturnValue({ name: DATASOURCE_TOOL, args: {} });
    const handler = new SessionEventHandler(host, notifier as unknown as PluginUpdateNotifier);

    handler.handleEvent(toolCallStarted(DATASOURCE_TOOL), sendQueued);
    handler.handleEvent(toolResult(), sendQueued);
    // The tool result alone must not trigger the notice mid-turn.
    expect(notifier.handleMcpToolCompleted).not.toHaveBeenCalled();

    handler.handleEvent(turnEnded('completed'), sendQueued);
    expect(notifier.handleMcpToolCompleted).toHaveBeenCalledTimes(1);
    expect(notifier.handleMcpToolCompleted).toHaveBeenCalledWith(DATASOURCE_TOOL);
  });

  it('skips the notice for a cancelled turn and clears the buffer', () => {
    const { host, streamingUI } = makeHost();
    const notifier = makeNotifier();
    streamingUI.completeToolResult.mockReturnValue({ name: DATASOURCE_TOOL, args: {} });
    const handler = new SessionEventHandler(host, notifier as unknown as PluginUpdateNotifier);

    handler.handleEvent(toolCallStarted(DATASOURCE_TOOL), sendQueued);
    handler.handleEvent(toolResult(), sendQueued);
    handler.handleEvent(turnEnded('cancelled'), sendQueued);
    expect(notifier.handleMcpToolCompleted).not.toHaveBeenCalled();

    // A later completed turn must not replay the cancelled turn's usage.
    handler.handleEvent(turnEnded('completed', 3), sendQueued);
    expect(notifier.handleMcpToolCompleted).not.toHaveBeenCalled();
  });

  it('ignores non-plugin tools', () => {
    const { host, streamingUI } = makeHost();
    const notifier = makeNotifier();
    streamingUI.completeToolResult.mockReturnValue({ name: 'Bash', args: {} });
    const handler = new SessionEventHandler(host, notifier as unknown as PluginUpdateNotifier);

    handler.handleEvent(toolCallStarted('Bash'), sendQueued);
    handler.handleEvent(toolResult(), sendQueued);
    handler.handleEvent(turnEnded('completed'), sendQueued);
    expect(notifier.handleMcpToolCompleted).not.toHaveBeenCalled();
  });

  it('reports a finished plugin command turn', () => {
    const { host } = makeHost();
    const notifier = makeNotifier();
    const handler = new SessionEventHandler(host, notifier as unknown as PluginUpdateNotifier);

    handler.handleEvent(pluginCommandTurnStarted(), sendQueued);
    handler.handleEvent(turnEnded('completed', 2), sendQueued);
    expect(notifier.handlePluginCommandCompleted).toHaveBeenCalledTimes(1);
    expect(notifier.handlePluginCommandCompleted).toHaveBeenCalledWith('kimi-datasource');
  });

  it('skips a cancelled plugin command turn', () => {
    const { host } = makeHost();
    const notifier = makeNotifier();
    const handler = new SessionEventHandler(host, notifier as unknown as PluginUpdateNotifier);

    handler.handleEvent(pluginCommandTurnStarted(), sendQueued);
    handler.handleEvent(turnEnded('cancelled', 2), sendQueued);
    expect(notifier.handlePluginCommandCompleted).not.toHaveBeenCalled();
  });
});
