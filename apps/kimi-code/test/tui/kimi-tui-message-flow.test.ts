import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deleteAllKittyImages,
  resetCapabilitiesCache,
  setCapabilities,
} from '@earendil-works/pi-tui';
import type { ApprovalRequest, ApprovalResponse, Event } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import {
  PluginMcpSelectorComponent,
  PluginMarketplaceSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsOverviewSelectorComponent,
} from '#/tui/components/dialogs/plugins-selector';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import { handleFeedbackCommand } from '#/tui/commands/info';
import {
  promptFeedbackInput,
  runModelSelector,
} from '#/tui/commands/prompts';
import type { QueuedMessage } from '#/tui/types';

vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return { ...actual, promptFeedbackInput: vi.fn() };
});
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

vi.mock('#/tui/utils/open-url', () => ({ openUrl: vi.fn() }));

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function stripSgr(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

interface MessageDriver {
  state: TUIState;
  streamingUI: StreamingUIController;
  sessionEventHandler: {
    startSubscription(): void;
    handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void;
  };
  init(): Promise<boolean>;
  handleUserInput(text: string): void;
  persistInputHistory(text: string): Promise<void>;
  getCurrentSessionId(): string;
}

interface FeedbackDriver extends MessageDriver {
  handleFeedbackCommand(): Promise<void>;
  promptFeedbackInput(): Promise<string | undefined>;
}

interface ModelSelectorDriver extends MessageDriver {
  runModelSelector(
    models: Record<
      string,
      {
        provider: string;
        model: string;
        maxContextSize: number;
        displayName?: string;
        capabilities?: string[];
      }
    >,
  ): Promise<{ alias: string; thinking: boolean } | undefined>;
}

function makeStartupInput(): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
    resolvedTheme: 'dark',
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: null },
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    cancelCompaction: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingLevel: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    onEvent: vi.fn(() => vi.fn()),
    listMcpServers: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getResumeState: vi.fn(() => ({
      sessionMetadata: {},
      agents: {
        main: {
          status: {
            model: 'k2',
            thinkingLevel: 'off',
            permission: 'manual',
            planMode: false,
            contextTokens: 0,
            maxContextTokens: 100,
            contextUsage: 0,
          },
          context: { history: [] },
          replay: [],
        },
      },
    })),
    close: vi.fn(async () => {}),
    listPlugins: vi.fn(async () => []),
    installPlugin: vi.fn(async () => ({
      id: 'demo',
      displayName: 'Demo',
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
    })),
    setPluginEnabled: vi.fn(async () => {}),
    setPluginMcpServerEnabled: vi.fn(async () => {}),
    removePlugin: vi.fn(async () => {}),
    reloadPlugins: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    getPluginInfo: vi.fn(async (id: string) => ({
      id,
      displayName: id,
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'local-path',
      root: `/plugins/${id}`,
      manifest: undefined,
      mcpServers: [],
      diagnostics: [],
    })),
    ...overrides,
  };
}

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 100 },
      },
    })),
    setConfig: vi.fn(async () => ({ providers: {} })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    forkSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    interactiveAgentId: 'main',
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      submitFeedback: vi.fn(
        async (): Promise<{ kind: 'ok' } | { kind: 'error'; status?: number; message: string }> => ({
          kind: 'ok',
        }),
      ),
    },
    ...overrides,
  };
}

async function makeDriver(
  session = makeSession(),
  harnessOverrides: Record<string, unknown> = {},
): Promise<{
  driver: MessageDriver;
  session: ReturnType<typeof makeSession>;
  harness: ReturnType<typeof makeHarness>;
}> {
  const harness = makeHarness(session, harnessOverrides);
  const driver = new KimiTUI(harness as never, makeStartupInput()) as unknown as MessageDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  driver.persistInputHistory = vi.fn(async () => {});
  await driver.init();
  return { driver, session, harness };
}

function renderTranscript(driver: MessageDriver): string {
  return driver.state.transcriptContainer.render(120).join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const tempDirs: string[] = [];
const originalKimiCodeHome = process.env['KIMI_CODE_HOME'];
const originalPluginMarketplaceUrl = process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'];
const originalVisual = process.env['VISUAL'];
const originalEditor = process.env['EDITOR'];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-code-tui-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetCapabilitiesCache();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalKimiCodeHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = originalKimiCodeHome;
  }
  if (originalVisual === undefined) {
    delete process.env['VISUAL'];
  } else {
    process.env['VISUAL'] = originalVisual;
  }
  if (originalPluginMarketplaceUrl === undefined) {
    delete process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'];
  } else {
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = originalPluginMarketplaceUrl;
  }
  if (originalEditor === undefined) {
    delete process.env['EDITOR'];
  } else {
    process.env['EDITOR'] = originalEditor;
  }
});

describe('KimiTUI message flow', () => {
  it('tracks editor shortcut and paste hooks', async () => {
    const { driver, harness } = await makeDriver();
    harness.track.mockClear();

    driver.state.editor.handleInput('\u001B[106;5u');
    driver.state.editor.handleInput('\u001F');
    delete process.env['VISUAL'];
    delete process.env['EDITOR'];
    driver.state.editor.onOpenExternalEditor?.();
    driver.state.editor.onToggleToolExpand?.();
    driver.state.editor.onTextPaste?.();

    expect(harness.track).toHaveBeenCalledWith('shortcut_newline', undefined);
    expect(harness.track).toHaveBeenCalledWith('undo', undefined);
    expect(harness.track).toHaveBeenCalledWith('shortcut_editor', undefined);
    expect(harness.track).toHaveBeenCalledWith('shortcut_expand', undefined);
    expect(harness.track).toHaveBeenCalledWith('shortcut_paste', { kind: 'text' });
  });

  it('tracks /clear as the clear alias for /new', async () => {
    const { driver, harness } = await makeDriver(makeSession({ id: 'ses-1' }));
    const nextSession = makeSession({ id: 'ses-2' });
    harness.createSession.mockResolvedValueOnce(nextSession);
    harness.track.mockClear();

    driver.handleUserInput('/clear');

    await vi.waitFor(() => {
      expect(driver.getCurrentSessionId()).toBe('ses-2');
    });
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'new' });
    expect(harness.track).toHaveBeenCalledWith('clear', undefined);
  });

  it('tracks theme changes from slash commands', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const { driver, harness } = await makeDriver();
    harness.track.mockClear();

    driver.handleUserInput('/theme light');

    await vi.waitFor(() => {
      expect(driver.state.appState.theme).toBe('light');
    });
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'theme' });
    expect(harness.track).toHaveBeenCalledWith('theme_switch', { theme: 'light' });
  });

  it('tracks successful feedback submissions only after the request succeeds', async () => {
    const { driver, harness } = await makeDriver(
      makeSession(),
      {
        getConfig: vi.fn(async () => ({
          models: {
            k2: {
              model: 'moonshot-v1',
              maxContextSize: 100,
              provider: 'managed:kimi-code',
            },
          },
        })),
      },
    );
    const feedbackDriver = driver as unknown as FeedbackDriver;
    vi.mocked(promptFeedbackInput).mockImplementation(async () => 'useful feedback');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok' });
    harness.track.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'useful feedback',
        sessionId: 'ses-1',
        version: 'kimi-code-0.0.0-test',
        model: 'k2',
      }),
    );
    expect(harness.track).toHaveBeenCalledWith('feedback_submitted', undefined);
  });

  it('shows feedback API error messages without replacing them with HTTP status text', async () => {
    const { driver, harness } = await makeDriver(
      makeSession(),
      {
        getConfig: vi.fn(async () => ({
          models: {
            k2: {
              model: 'moonshot-v1',
              maxContextSize: 100,
              provider: 'managed:kimi-code',
            },
          },
        })),
      },
    );
    const feedbackDriver = driver as unknown as FeedbackDriver;
    vi.mocked(promptFeedbackInput).mockImplementation(async () => 'useful feedback');
    harness.auth.submitFeedback.mockResolvedValueOnce({
      kind: 'error',
      status: 500,
      message: 'backend says no',
    });

    await handleFeedbackCommand(feedbackDriver as any);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('backend says no');
    expect(transcript).toContain('Opening GitHub Issues as fallback');
    expect(transcript).not.toContain('Failed to submit feedback (HTTP 500).');
  });

  it('does not track feedback when the dialog is cancelled', async () => {
    const { driver, harness } = await makeDriver(
      makeSession(),
      {
        getConfig: vi.fn(async () => ({
          models: {
            k2: {
              model: 'moonshot-v1',
              maxContextSize: 100,
              provider: 'managed:kimi-code',
            },
          },
        })),
      },
    );
    const feedbackDriver = driver as unknown as FeedbackDriver;
    vi.mocked(promptFeedbackInput).mockImplementation(async () => undefined);
    harness.track.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).not.toHaveBeenCalled();
    expect(harness.track).not.toHaveBeenCalledWith('feedback_submitted', undefined);
  });

  it('tracks blocked slash commands as invalid without counting them as executed commands', async () => {
    const { driver, harness } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    for (const command of ['/new', '/model', '/sessions']) {
      harness.track.mockClear();

      driver.handleUserInput(command);
      await Promise.resolve();

      expect(harness.track).toHaveBeenCalledWith('input_command_invalid', {
        reason: 'blocked',
        command: command.slice(1),
      });
      expect(harness.track).not.toHaveBeenCalledWith('input_command', {
        command: command.slice(1),
      });
    }
  });

  it('does not re-enter plan mode after creating a plan-mode session', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingLevel: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const { driver, harness } = await makeDriver(session);
    harness.createSession.mockClear();
    session.setPlanMode.mockClear();
    driver.state.appState.planMode = true;

    driver.handleUserInput('/new');

    await vi.waitFor(() => {
      expect(harness.createSession).toHaveBeenCalledWith({
        workDir: '/tmp/proj-a',
        model: 'k2',
        thinking: 'off',
        permission: 'manual',
        planMode: true,
      });
    });
    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).not.toContain('Post-create setup failed');
  });

  it('keeps the new session subscribed when post-create setup fails', async () => {
    const initialSession = makeSession({ id: 'ses-initial' });
    const failedSession = makeSession({
      id: 'ses-failed',
      setPermission: vi.fn(async () => {
        throw new Error('permission setup failed');
      }),
    });
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(initialSession)
      .mockResolvedValueOnce(failedSession);
    const { driver } = await makeDriver(initialSession, { createSession });
    vi.mocked(failedSession.onEvent).mockClear();

    driver.handleUserInput('/new');

    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Post-create setup failed: permission setup failed',
      );
    });
    expect(failedSession.onEvent).toHaveBeenCalledOnce();
  });

  it('tracks Shift-Tab mode switches through the editor handler', async () => {
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();

    driver.state.editor.onShiftTab?.();

    await vi.waitFor(() => {
      expect(session.setPlanMode).toHaveBeenCalledWith(true);
    });
    expect(harness.track).toHaveBeenCalledWith('shortcut_plan_toggle', { enabled: true });
    expect(harness.track).toHaveBeenCalledWith('shortcut_mode_switch', { to_mode: 'plan' });
  });

  it('routes /yolo through session permission state without app-layer telemetry duplication', async () => {
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();

    driver.handleUserInput('/yolo on');

    await vi.waitFor(() => {
      expect(session.setPermission).toHaveBeenCalledWith('yolo');
    });
    expect(driver.state.appState).toMatchObject({
      permissionMode: 'yolo',
    });
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'yolo' });
    expect(harness.track).not.toHaveBeenCalledWith('yolo_toggle', expect.anything());
  });

  it('hydrates MCP server status after subscribing to session events', async () => {
    const session = makeSession({
      listMcpServers: vi.fn(async () => [
        {
          name: 'local-tools',
          transport: 'stdio',
          status: 'connected',
          toolCount: 2,
        },
        {
          name: 'remote-tools',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: 'connection refused',
        },
      ]),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.startSubscription();
    await Promise.resolve();

    expect(session.onEvent).toHaveBeenCalledOnce();
    expect(session.listMcpServers).toHaveBeenCalledOnce();
    const subscribeOrder = session.onEvent.mock.invocationCallOrder[0];
    const snapshotOrder = session.listMcpServers.mock.invocationCallOrder[0];
    if (subscribeOrder === undefined || snapshotOrder === undefined) {
      throw new Error('Expected MCP status sync to subscribe and fetch a snapshot.');
    }
    expect(subscribeOrder).toBeLessThan(snapshotOrder);
    const transcript = renderTranscript(driver);
    expect(transcript).toContain('MCP server "local-tools" connected');
    expect(transcript).toContain('2 tools (stdio)');
    expect(transcript).toContain('MCP server "remote-tools" failed: connection refused');
  });

  it('deduplicates identical MCP status updates while allowing reconnect transitions', async () => {
    const eventListeners: Array<(event: Event) => void> = [];
    const connectedServer = {
      name: 'local-tools',
      transport: 'stdio',
      status: 'connected',
      toolCount: 2,
    };
    const session = makeSession({
      onEvent: vi.fn((listener: (event: Event) => void) => {
        eventListeners.push(listener);
        return vi.fn();
      }),
      listMcpServers: vi.fn(async () => [connectedServer]),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.startSubscription();
    await Promise.resolve();
    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: connectedServer,
    } as Event);

    expect(countOccurrences(renderTranscript(driver), 'MCP server "local-tools" connected')).toBe(
      1,
    );

    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: {
        ...connectedServer,
        status: 'pending',
        toolCount: 0,
      },
    } as Event);
    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: connectedServer,
    } as Event);

    expect(countOccurrences(renderTranscript(driver), 'MCP server "local-tools" connected')).toBe(
      2,
    );
  });

  it('does not let a late MCP snapshot overwrite a live status event', async () => {
    const eventListeners: Array<(event: Event) => void> = [];
    let resolveSnapshot: (
      servers: Array<{
        name: string;
        transport: 'stdio' | 'http';
        status: 'pending' | 'connected' | 'failed' | 'disabled';
        toolCount: number;
        error?: string;
      }>,
    ) => void = () => {};
    const snapshot = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    const session = makeSession({
      onEvent: vi.fn((listener: (event: Event) => void) => {
        eventListeners.push(listener);
        return vi.fn();
      }),
      listMcpServers: vi.fn(() => snapshot),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.startSubscription();
    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: {
        name: 'local-tools',
        transport: 'stdio',
        status: 'connected',
        toolCount: 2,
      },
    } as Event);
    resolveSnapshot([
      {
        name: 'local-tools',
        transport: 'stdio',
        status: 'failed',
        toolCount: 0,
        error: 'stale failure',
      },
    ]);
    await Promise.resolve();

    const transcript = renderTranscript(driver);
    expect(transcript).toContain('MCP server "local-tools" connected');
    expect(transcript).not.toContain('stale failure');
  });

  it('sends normal editor input to the active session and marks the turn as waiting', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');

    expect(session.prompt).toHaveBeenCalledWith('hello');
    expect(driver.state.appState.streamingPhase).not.toBe('idle');
    expect(driver.state.appState.streamingPhase).toBe('waiting');
    expect(driver.state.livePane.mode).toBe('waiting');
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
  });

  it('sends pasted image placeholders as image content parts', async () => {
    const { driver, session } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);

    driver.handleUserInput(`describe ${attachment.placeholder}`);

    expect(session.prompt).toHaveBeenCalledWith([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: `describe ${attachment.placeholder}`,
        imageAttachmentIds: [attachment.id],
      }),
    ]);
  });

  it('queues editor input instead of prompting while a turn is already streaming', async () => {
    const { driver, session, harness } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    harness.track.mockClear();

    driver.handleUserInput('queued message');

    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'queued message', agentId: 'main' }]);
    expect(driver.state.queueContainer.children.length).toBeGreaterThan(0);
    expect(harness.track).toHaveBeenCalledWith('input_queue', undefined);
  });

  it('cancels active streaming from Escape and Ctrl-C editor shortcuts', async () => {
    const { driver, session } = await makeDriver();

    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);

    session.cancel.mockClear();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.onCtrlC?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it('dispatches the next queued message after the active turn ends', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = await makeDriver();
      const sendQueued = vi.fn();
      driver.state.appState.streamingPhase = 'waiting';
      driver.state.appState.streamingStartTime = 1;
      driver.streamingUI.setTurnId('1');
      driver.state.queuedMessages = [{ text: 'next' }];

      driver.sessionEventHandler.handleEvent(
        {
          type: 'turn.ended',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          reason: 'completed',
        } as Event,
        sendQueued,
      );
      await vi.runAllTimersAsync();

      expect(sendQueued).toHaveBeenCalledWith({ text: 'next' });
      expect(driver.state.queuedMessages).toEqual([]);
      expect(driver.state.appState.streamingPhase).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces assistant delta component updates', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = await makeDriver();
      vi.mocked(driver.state.ui.requestRender).mockClear();

      driver.sessionEventHandler.handleEvent(
        {
          type: 'assistant.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          delta: 'a',
        } as Event,
        vi.fn(),
      );
      const component = driver.streamingUI.getStreamingBlockComponent();
      if (component === undefined) throw new Error('expected streaming component');
      const updateSpy = vi.spyOn(component, 'updateContent');

      driver.sessionEventHandler.handleEvent(
        {
          type: 'assistant.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          delta: 'b',
        } as Event,
        vi.fn(),
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'assistant.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          delta: 'c',
        } as Event,
        vi.fn(),
      );

      expect(updateSpy).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenLastCalledWith('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending assistant deltas before turn completion', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = await makeDriver();
      const sendQueued = vi.fn();
      driver.state.appState.streamingPhase = 'waiting';

      driver.sessionEventHandler.handleEvent(
        {
          type: 'assistant.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          delta: 'done',
        } as Event,
        sendQueued,
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'turn.ended',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          reason: 'completed',
        } as Event,
        sendQueued,
      );

      expect(stripSgr(renderTranscript(driver))).toContain('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces streaming tool-call argument preview updates', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = await makeDriver();
      driver.streamingUI.setTurnId('1');
      driver.streamingUI.setStep(1);

      driver.sessionEventHandler.handleEvent(
        {
          type: 'tool.call.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          toolCallId: 'call_bash',
          name: 'Bash',
          argumentsPart: '{"command":"echo hi"}',
        } as Event,
        vi.fn(),
      );

      expect(driver.streamingUI.getToolComponent('call_bash')).toBeUndefined();
      expect(driver.streamingUI.hasActiveToolCall('call_bash')).toBe(false);

      await vi.runOnlyPendingTimersAsync();

      expect(driver.streamingUI.getToolComponent('call_bash')).toBeDefined();
      expect(driver.streamingUI.getActiveToolCall('call_bash')?.args).toMatchObject({
        command: 'echo hi',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels manual compaction from the editor', async () => {
    const { driver, session } = await makeDriver();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      vi.fn(),
    );

    driver.state.editor.onEscape?.();

    expect(session.cancelCompaction).toHaveBeenCalledTimes(1);

    session.cancelCompaction.mockClear();
    driver.state.appState.isCompacting = true;
    driver.state.editor.onCtrlC?.();

    expect(session.cancelCompaction).toHaveBeenCalledTimes(1);
  });

  it('dispatches the next queued message after compaction is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const { driver } = await makeDriver();
      const sendQueued = vi.fn();
      driver.sessionEventHandler.handleEvent(
        {
          type: 'compaction.started',
          agentId: 'main',
          sessionId: 'ses-1',
          trigger: 'manual',
        } as Event,
        sendQueued,
      );
      driver.state.queuedMessages = [{ text: 'next' }];

      driver.sessionEventHandler.handleEvent(
        {
          type: 'compaction.cancelled',
          agentId: 'main',
          sessionId: 'ses-1',
        } as Event,
        sendQueued,
      );
      await vi.runAllTimersAsync();

      expect(driver.state.appState.isCompacting).toBe(false);
      expect(driver.state.appState.streamingPhase).toBe('idle');
      expect(driver.state.queuedMessages).toEqual([]);
      expect(sendQueued).toHaveBeenCalledWith({ text: 'next' });
      expect(driver.state.transcriptContainer.render(120).map(stripSgr).join('\n')).toContain(
        'Compaction cancelled',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders an error instead of prompting when no model is selected', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.model = '';

    driver.handleUserInput('hello');

    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.transcriptContainer.render(120).join('\n')).toContain('LLM not set');
  });

  it('dispatches /init to the active session and clears busy state after completion', async () => {
    let resolveInit: (() => void) | undefined;
    const session = makeSession({
      init: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      ),
    });
    const { driver, harness } = await makeDriver(session);
    harness.track.mockClear();

    driver.handleUserInput('/init');

    await vi.waitFor(() => {
      expect(session.init).toHaveBeenCalledTimes(1);
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.appState.streamingPhase).not.toBe('idle');
    expect(driver.state.livePane.mode).toBe('waiting');

    resolveInit?.();

    await vi.waitFor(() => {
      expect(driver.state.appState.streamingPhase).toBe('idle');
    });
    expect(driver.state.livePane.mode).toBe('idle');
    expect(harness.track).toHaveBeenCalledWith('init_complete', undefined);
  });

  it('queues Ctrl-S input instead of steering while /init is running', async () => {
    let resolveInit: (() => void) | undefined;
    const session = makeSession({
      init: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      ),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/init');
    await vi.waitFor(() => {
      expect(session.init).toHaveBeenCalledTimes(1);
    });

    driver.state.editor.setText('apply after init');
    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'apply after init', agentId: 'main' }]);
    expect(stripSgr(driver.state.queueContainer.render(120).join('\n'))).not.toContain(
      'ctrl-s to steer immediately',
    );

    resolveInit?.();

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledWith('apply after init');
    });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('cancels the active /init request through the session', async () => {
    let resolveInit: (() => void) | undefined;
    const session = makeSession({
      init: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      ),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/init');
    await vi.waitFor(() => {
      expect(session.init).toHaveBeenCalledTimes(1);
    });

    driver.state.editor.onEscape?.();

    await vi.waitFor(() => {
      expect(session.cancel).toHaveBeenCalledTimes(1);
    });

    resolveInit?.();
  });

  it('does not run /init when no model is selected', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.model = '';

    driver.handleUserInput('/init');

    expect(session.init).not.toHaveBeenCalled();
    expect(driver.state.transcriptContainer.render(120).join('\n')).toContain('LLM not set');
  });

  it('shows the login prompt for auth.login_required session errors', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: 'ses-1',
        code: 'auth.login_required',
        message: 'OAuth provider credentials were rejected.',
        retryable: false,
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('OAuth login expired. Send /login to login.');
    expect(transcript).not.toContain('[auth.login_required]');
    expect(transcript).not.toContain('kimi export');
  });

  it('appends the kimi export hint beneath session error messages', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: 'ses-1',
        code: 'compaction.failed',
        message: "APIStatusError: 400 the message at position 82 with role 'assistant' must not be empty",
        retryable: false,
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(driver.state.transcriptContainer.render(200).join('\n'));
    expect(transcript).toContain('Error: [compaction.failed]');
    expect(transcript).toContain('If this persists, run `kimi export ses-1`');
    expect(transcript).toContain("Please don't share it publicly");
  });

  it('skips the kimi export hint when no active session id is set', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.sessionId = '';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: '',
        code: 'compaction.failed',
        message: 'boom',
        retryable: false,
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Error: [compaction.failed]');
    expect(transcript).not.toContain('kimi export');
  });

  it('shows ExitPlanMode plan only in the current-plan card during approval', async () => {
    const planContent = '# No Duplicate Plan\n\n- Do the non-duplicated plan work';
    const session = makeSession({
      getPlan: vi.fn(async () => ({
        id: 'no-duplicate-plan',
        content: planContent,
        path: '/tmp/no-duplicate-plan.md',
      })),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_exit_plan',
        name: 'ExitPlanMode',
        args: {},
      } as Event,
      vi.fn(),
    );

    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Current plan');
      expect(countOccurrences(transcript, 'non-duplicated plan work')).toBe(1);
    });

    const approvalHandler = vi.mocked(session.setApprovalHandler).mock.calls[0]?.[0] as
      | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
      | undefined;
    if (approvalHandler === undefined) throw new Error('expected approval handler');
    void approvalHandler({
      turnId: 1,
      toolCallId: 'call_exit_plan',
      toolName: 'ExitPlanMode',
      action: 'Review plan',
      display: {
        kind: 'plan_review',
        plan: planContent,
        path: '/tmp/no-duplicate-plan.md',
      },
    });

    await vi.waitFor(() => {
      const approval = stripSgr(driver.state.editorContainer.render(120).join('\n'));
      expect(approval).toContain('Ready to build with this plan?');
      expect(approval).not.toContain('non-duplicated plan work');
      expect(approval).not.toContain('/tmp/no-duplicate-plan.md');
    });
  });

  it('shows plan review reject on the plan card without an approval notice', async () => {
    const planContent = '# Reject Plan\n\n- keep this plan visible after reject';
    const session = makeSession({
      getPlan: vi.fn(async () => ({
        id: 'reject-plan',
        content: planContent,
        path: '/tmp/reject-plan.md',
      })),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_exit_reject_plan',
        name: 'ExitPlanMode',
        args: {},
      } as Event,
      vi.fn(),
    );

    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Reject Plan');
      expect(countOccurrences(transcript, 'keep this plan visible after reject')).toBe(1);
    });

    const approvalHandler = vi.mocked(session.setApprovalHandler).mock.calls[0]?.[0] as
      | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
      | undefined;
    if (approvalHandler === undefined) throw new Error('expected approval handler');
    const response = approvalHandler({
      turnId: 1,
      toolCallId: 'call_exit_reject_plan',
      toolName: 'ExitPlanMode',
      action: 'Review plan',
      display: {
        kind: 'plan_review',
        plan: planContent,
        path: '/tmp/reject-plan.md',
      },
    });

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(ApprovalPanelComponent);
    });
    (driver.state.editorContainer.children[0] as ApprovalPanelComponent).handleInput('2');
    await expect(response).resolves.toMatchObject({ decision: 'rejected' });

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_exit_reject_plan',
        output: 'Plan rejected by user. Plan mode remains active.',
        isError: true,
      } as Event,
      vi.fn(),
    );

    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('plan: reject-plan.md · Rejected');
      expect(transcript).toContain('Reject Plan');
      expect(countOccurrences(transcript, 'keep this plan visible after reject')).toBe(1);
      expect(transcript).not.toContain('Rejected: Review plan');
      expect(transcript).not.toContain('Plan rejected by user.');
      expect(transcript).not.toContain('Plan mode remains active.');
    });
  });

  it('renders /status using the active session runtime status', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingLevel: 'high',
        permission: 'auto',
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 100,
        contextUsage: 0.25,
      })),
    });
    const { driver } = await makeDriver(session);
    const getStatus = vi.mocked(session.getStatus);
    const previousStatusCalls = getStatus.mock.calls.length;

    driver.handleUserInput('/status');

    await vi.waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(previousStatusCalls + 1);
      const output = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(output).toContain(' Status ');
      expect(output).toContain('>_ Kimi Code');
      expect(output).toContain('Model');
      expect(output).toContain('thinking on');
      expect(output).toContain('Permissions  auto');
      expect(output).toContain('Plan mode    on');
      expect(output).toContain('Context window');
      expect(output).toContain('25.0%');
    });
  });

  it('renders /mcp using a fresh MCP server snapshot', async () => {
    const session = makeSession({
      listMcpServers: vi.fn(async () => [
        {
          name: 'local-tools',
          transport: 'stdio',
          status: 'connected',
          toolCount: 2,
        },
        {
          name: 'remote-tools',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: 'connection refused',
        },
        {
          name: 'linear',
          transport: 'http',
          status: 'needs-auth',
          toolCount: 0,
        },
        {
          name: 'disabled-tools',
          transport: 'stdio',
          status: 'disabled',
          toolCount: 0,
        },
      ]),
    });
    const { driver } = await makeDriver(session);
    const listMcpServers = vi.mocked(session.listMcpServers);
    const previousCalls = listMcpServers.mock.calls.length;

    driver.handleUserInput('/mcp');

    await vi.waitFor(() => {
      expect(listMcpServers).toHaveBeenCalledTimes(previousCalls + 1);
      const output = stripSgr(driver.state.transcriptContainer.render(140).join('\n'));
      expect(output).toContain(' MCP (4) ');
      expect(output).toContain('Servers');
      expect(output).toContain('local-tools');
      expect(output).toContain('connected');
      expect(output).toContain('stdio');
      expect(output).toContain('2 tools');
      expect(output).toContain('remote-tools');
      expect(output).toContain('failed');
      expect(output).toContain('connection refused');
      expect(output).toContain('linear');
      expect(output).toContain('needs auth');
      expect(output).toContain('/mcp-config login linear');
      expect(output).toContain('disabled-tools');
      expect(output).toContain('disabled');
      expect(output).toContain('1 connected · 1 needs auth · 1 failed · 1 disabled · 2 tools available');
    });
  });

  it('renders an empty /mcp state when no MCP servers are configured', async () => {
    const session = makeSession({
      listMcpServers: vi.fn(async () => []),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/mcp');

    await vi.waitFor(() => {
      const output = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(output).toContain('No MCP servers configured. Run /mcp-config to add one.');
    });
  });

  it('renders /mcp list failures as command boundary errors', async () => {
    const session = makeSession({
      listMcpServers: vi.fn(async () => {
        throw new Error('rpc unavailable');
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/mcp');

    await vi.waitFor(() => {
      const output = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(output).toContain('Error: Failed to load MCP servers: rpc unavailable');
    });
  });

  it('toggles plugin MCP servers from the text command', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins mcp enable kimi-datasource data');

    await vi.waitFor(() => {
      expect(session.setPluginMcpServerEnabled).toHaveBeenCalledWith(
        'kimi-datasource',
        'data',
        true,
      );
    });
  });

  it('errors when /plugins install has no argument', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install');

    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Usage: /plugins install <local-path-or-zip-url>',
      );
    });
    expect(session.installPlugin).not.toHaveBeenCalled();
  });

  it('installs from a positional source on /plugins install', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install ./plugins/kimi-datasource');

    await vi.waitFor(() => {
      expect(session.installPlugin).toHaveBeenCalledWith('/tmp/proj-a/plugins/kimi-datasource');
    });
  });

  it('loads a local plugin marketplace file and installs from it', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-datasource',
            displayName: 'Kimi Datasource',
            description: 'Datasource plugin',
            source: './kimi-datasource',
          },
        ],
      }),
      'utf8',
    );
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = marketplacePath;
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins marketplace');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginMarketplaceSelectorComponent,
      );
    });
    const picker = driver.state.editorContainer.children[0] as PluginMarketplaceSelectorComponent;
    picker.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(join(marketplaceDir, 'kimi-datasource'));
    });
    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Installing or updating Kimi Datasource from marketplace...');
      expect(transcript).toContain('Installed or updated Demo');
    });
  });

  it('toggles plugins from the overview with space', async () => {
    let enabled = true;
    const session = makeSession({
      listPlugins: vi.fn(async () => [
        {
          id: 'demo',
          displayName: 'Demo',
          version: '1.0.0',
          enabled,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
        },
      ]),
      setPluginEnabled: vi.fn(async (_id: string, nextEnabled: boolean) => {
        enabled = nextEnabled;
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginsOverviewSelectorComponent,
      );
    });
    const overview = driver.state.editorContainer.children[0] as PluginsOverviewSelectorComponent;
    overview.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.setPluginEnabled).toHaveBeenCalledWith('demo', false);
    });
    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginsOverviewSelectorComponent,
      );
    });
    const out = stripSgr(driver.state.editorContainer.children[0]!.render(120).join('\n'));
    expect(out).toContain('❯ Demo  disabled  pending /new');
    expect(out).not.toContain('Space enable');
    expect(stripSgr(renderTranscript(driver))).not.toContain('Disabled demo. Run /new to apply.');
  });

  it('toggles plugin MCP servers from the overview MCP picker', async () => {
    const serverEnabled = new Map([
      ['metadata', true],
      ['data', true],
    ]);
    const session = makeSession({
      listPlugins: vi.fn(async () => [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 2,
          enabledMcpServerCount: 2,
          hasErrors: false,
        },
      ]),
      getPluginInfo: vi.fn(async () => ({
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        version: '1.0.0',
        enabled: true,
        state: 'ok',
        skillCount: 1,
        mcpServerCount: 2,
        enabledMcpServerCount: [...serverEnabled.values()].filter(Boolean).length,
        hasErrors: false,
        source: 'local-path',
        root: '/plugins/kimi-datasource',
        manifest: undefined,
        mcpServers: [
          {
            name: 'metadata',
            runtimeName: 'plugin-kimi-datasource-metadata',
            enabled: serverEnabled.get('metadata') === true,
            transport: 'stdio',
            command: 'node',
            args: ['./bin/kimi-datasource.mjs', 'metadata'],
          },
          {
            name: 'data',
            runtimeName: 'plugin-kimi-datasource-data',
            enabled: serverEnabled.get('data') === true,
            transport: 'stdio',
            command: 'node',
            args: ['./bin/kimi-datasource.mjs', 'data'],
          },
        ],
        diagnostics: [],
      })),
      setPluginMcpServerEnabled: vi.fn(async (_id: string, _server: string, nextEnabled: boolean) => {
        serverEnabled.set(_server, nextEnabled);
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginsOverviewSelectorComponent,
      );
    });
    const overview = driver.state.editorContainer.children[0] as PluginsOverviewSelectorComponent;
    overview.handleInput('m');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginMcpSelectorComponent,
      );
    });
    const mcpPicker = driver.state.editorContainer.children[0] as PluginMcpSelectorComponent;
    mcpPicker.handleInput('\u001B[B');
    mcpPicker.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.setPluginMcpServerEnabled).toHaveBeenCalledWith(
        'kimi-datasource',
        'data',
        false,
      );
    });
    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginMcpSelectorComponent);
    });
    const out = stripSgr(driver.state.editorContainer.children[0]!.render(120).join('\n'));
    expect(out).toContain('❯ data  disabled  pending /new');
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Disabled MCP server data for kimi-datasource. Run /new to apply.',
    );
  });

  it('requires confirmation before /plugins remove removes a plugin', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins remove demo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginRemoveConfirmComponent,
      );
    });
    expect(session.removePlugin).not.toHaveBeenCalled();

    const confirm = driver.state.editorContainer.children[0] as PluginRemoveConfirmComponent;
    expect(stripSgr(confirm.render(120).join('\n'))).toContain('Remove demo (demo)?');
    confirm.handleInput('\r');

    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Remove cancelled: demo.');
    });
    expect(session.removePlugin).not.toHaveBeenCalled();
  });

  it('renders /plugins <id> info to the transcript', async () => {
    const session = makeSession({
      listPlugins: vi.fn(async () => [
        {
          id: 'demo',
          displayName: 'Demo',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
        },
      ]),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins demo');

    await vi.waitFor(() => {
      expect(session.getPluginInfo).toHaveBeenCalledWith('demo');
    });
  });

  it('applies /model selection with inline thinking state', async () => {
    const session = makeSession();
    const setConfig = vi.fn(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Kimi Turbo',
            capabilities: ['thinking'],
          },
        },
        defaultModel: 'k2',
        defaultThinking: false,
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    const picker = driver.state.editorContainer.children[0];
    expect(picker).toBeInstanceOf(ModelSelectorComponent);
    const pickerOutput = stripSgr((picker as ModelSelectorComponent).render(120).join('\n'));
    expect(pickerOutput).toContain('Kimi K2 (Kimi Code) ← current');
    expect(pickerOutput).toContain('❯ Kimi Turbo (Kimi Code)');
    (picker as ModelSelectorComponent).handleInput('t');
    (picker as ModelSelectorComponent).handleInput('u');
    const filteredOutput = stripSgr((picker as ModelSelectorComponent).render(120).join('\n'));
    expect(filteredOutput).toContain('Search: tu');
    expect(filteredOutput).toContain('Kimi Turbo (Kimi Code)');
    expect(filteredOutput).not.toContain('Kimi K2 (Kimi Code)');
    (picker as ModelSelectorComponent).handleInput('\u001B[D');
    (picker as ModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('turbo');
      expect(session.setThinking).toHaveBeenCalledWith('on');
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        defaultThinking: true,
      });
    });
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinking).toBe(true);
  });

  it('persists /model selection even when runtime state is unchanged', async () => {
    const session = makeSession();
    const setConfig = vi.fn(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
        },
        defaultModel: 'old-default',
        defaultThinking: true,
      })),
      setConfig,
    });

    driver.handleUserInput('/model k2');

    const picker = driver.state.editorContainer.children[0];
    expect(picker).toBeInstanceOf(ModelSelectorComponent);
    (picker as ModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'k2',
        defaultThinking: false,
      });
    });
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
  });

  it('enables search in the shared model selector helper', async () => {
    const { driver } = await makeDriver();
    const selection = runModelSelector(driver as any, {
      alpha: {
        provider: 'managed:kimi-code',
        model: 'kimi-alpha',
        maxContextSize: 100,
        displayName: 'Kimi Alpha',
        capabilities: ['thinking'],
      },
      turbo: {
        provider: 'managed:kimi-code',
        model: 'kimi-turbo',
        maxContextSize: 100,
        displayName: 'Kimi Turbo',
        capabilities: ['thinking'],
      },
    });

    const picker = driver.state.editorContainer.children[0];
    expect(picker).toBeInstanceOf(ModelSelectorComponent);
    (picker as ModelSelectorComponent).handleInput('t');
    (picker as ModelSelectorComponent).handleInput('u');

    const output = stripSgr((picker as ModelSelectorComponent).render(120).join('\n'));
    expect(output).toContain('Search: tu');
    expect(output).toContain('Kimi Turbo (Kimi Code)');
    expect(output).not.toContain('Kimi Alpha (Kimi Code)');

    (picker as ModelSelectorComponent).handleInput('\u001B');
    (picker as ModelSelectorComponent).handleInput('\u001B');
    await expect(selection).resolves.toBeUndefined();
  });

  it('deletes Kitty inline images when /new clears the transcript', async () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const { driver, harness } = await makeDriver(makeSession({ id: 'ses-1' }));
    const nextSession = makeSession({ id: 'ses-2' });
    harness.createSession.mockResolvedValueOnce(nextSession);
    const write = vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});

    driver.handleUserInput('/new');

    await vi.waitFor(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(2);
      expect(driver.getCurrentSessionId()).toBe('ses-2');
    });
    expect(write).toHaveBeenCalledWith(deleteAllKittyImages());
  });

  it('forks the active session and switches to the returned session', async () => {
    const originalTitle = process.title;
    const source = makeSession({
      id: 'ses-source',
      summary: { title: 'Source title' },
    });
    const forked = makeSession({
      id: 'ses-fork',
      summary: { title: 'Fork: Source title' },
    });
    const forkSession = vi.fn(async () => forked);
    const { driver, harness } = await makeDriver(source, { forkSession });

    try {
      driver.handleUserInput('/fork ignored args');

      await vi.waitFor(() => {
        expect(forkSession).toHaveBeenCalledWith({
          id: 'ses-source',
          title: 'Fork: Source title',
        });
        expect(driver.getCurrentSessionId()).toBe('ses-fork');
      });
      expect(process.title).toBe('Fork: Source title');
      expect(source.close).toHaveBeenCalledOnce();
      expect(forked.onEvent).toHaveBeenCalledOnce();
      expect(harness.resumeSession).not.toHaveBeenCalled();
      expect(driver.state.transcriptContainer.render(120).join('\n')).toContain(
        'Session forked (ses-fork). To return to the original session: kimi -r ses-source',
      );
    } finally {
      process.title = originalTitle;
    }
  });

  it('keeps the current session when fork fails', async () => {
    const forkSession = vi.fn(async () => {
      throw new Error('fork unavailable');
    });
    const { driver } = await makeDriver(makeSession({ id: 'ses-source' }), { forkSession });

    driver.handleUserInput('/fork');

    await vi.waitFor(() => {
      expect(forkSession).toHaveBeenCalledWith({
        id: 'ses-source',
        title: 'Fork: ses-source',
      });
      expect(driver.getCurrentSessionId()).toBe('ses-source');
      expect(driver.state.transcriptContainer.render(120).join('\n')).toContain(
        'Failed to fork session: fork unavailable',
      );
    });
  });

  it('does not create a thinking component for empty thinking deltas', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'thinking';
    driver.state.appState.streamingStartTime = 1;

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: '',
      } as Event,
      vi.fn(),
    );

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
  });

  it('finalizes an orphaned thinking component on turn end', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'thinking';
    driver.state.appState.streamingStartTime = 1;
    const sendQueued = vi.fn();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'leaked',
      } as Event,
      vi.fn(),
    );
    driver.streamingUI.flushNow();
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        reason: 'completed',
      } as Event,
      sendQueued,
    );

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
  });

  it('renders newly streamed thinking expanded when ctrl+o toggle was already active', async () => {
    const { driver } = await makeDriver();
    driver.state.toolOutputExpanded = true;

    const longThinking = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].join('\n');
    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: longThinking,
      } as Event,
      vi.fn(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'answer',
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('t7');
    expect(transcript).not.toContain('ctrl+o to expand');
  });

  it('renders hook results without XML tags', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'hook.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        hookEvent: 'UserPromptSubmit',
        content: '{}',
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('UserPromptSubmit hook');
    expect(transcript).toContain('{}');
    expect(transcript).not.toContain('<hook_result');
  });

  it('renders empty hook results as empty status text', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'hook.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        hookEvent: 'UserPromptSubmit',
        content: '',
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('UserPromptSubmit hook');
    expect(transcript).toContain('(empty)');
    expect(transcript).not.toContain('<hook_result');
  });
});
