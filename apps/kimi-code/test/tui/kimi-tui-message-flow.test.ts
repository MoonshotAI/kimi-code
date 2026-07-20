import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  deleteAllKittyImages,
  resetCapabilitiesCache,
  setCapabilities,
} from '@moonshot-ai/pi-tui';
import type { ApprovalRequest, ApprovalResponse, Event } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';
import { KIMI_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import { MOON_SPINNER_FRAMES } from '#/tui/constant/rendering';
import {
  AgentSwarmProgressComponent,
  agentSwarmGridHeightForTerminalRows,
} from '#/tui/components/messages/agent-swarm-progress';
import { BtwPanelComponent } from '#/tui/components/panes/btw-panel';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { UndoSelectorComponent } from '#/tui/components/dialogs/undo-selector';
import {
  PluginInstallTrustConfirmComponent,
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsPanelComponent,
} from '#/tui/components/dialogs/plugins-selector';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import { handleFeedbackCommand } from '#/tui/commands/info';
import { packageCodebase, scanCodebase } from '../../src/feedback/codebase';
import { uploadArchive } from '../../src/feedback/upload';
import {
  promptFeedbackAttachment,
  promptFeedbackInput,
  runModelSelector,
  type FeedbackPromptResult,
} from '#/tui/commands/prompts';
import type { QueuedMessage } from '#/tui/types';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return {
    ...actual,
    promptFeedbackInput: vi.fn(),
    promptFeedbackAttachment: vi.fn(),
  };
});

vi.mock('../../src/feedback/codebase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/feedback/codebase')>();
  return {
    ...actual,
    scanCodebase: vi.fn().mockResolvedValue(undefined),
    packageCodebase: vi.fn(),
  };
});

vi.mock('../../src/feedback/upload', () => ({
  uploadArchive: vi.fn(),
}));

// /feedback falls back to opening GitHub Issues in a browser when not signed in
// or when submission fails — stub it out so the test suite never spawns a
// browser window.
vi.mock('#/utils/open-url', () => ({ openUrl: vi.fn() }));

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
  sendQueuedMessage(session: unknown, item: QueuedMessage): void;
  getCurrentSessionId(): string;
}

interface FeedbackDriver extends MessageDriver {
  handleFeedbackCommand(): Promise<void>;
  promptFeedbackInput(): Promise<FeedbackPromptResult | undefined>;
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
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  let model = 'k2';
  let thinkingEffort = 'off';
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: null },
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    startBtw: vi.fn(async () => 'agent-btw'),
    undoHistory: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    cancelCompaction: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      model,
      thinkingEffort,
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    getGoal: vi.fn(async () => ({ goal: null })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async (alias: string) => {
      model = alias;
    }),
    setThinking: vi.fn(async (effort: string) => {
      thinkingEffort = effort;
    }),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    setSwarmMode: vi.fn(async () => {}),
    onEvent: vi.fn(() => vi.fn()),
    listMcpServers: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getResumeState: vi.fn(() => ({
      sessionMetadata: {},
      agents: {
        main: {
          status: {
            model: 'k2',
            thinkingEffort: 'off',
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
      source: 'local-path',
    })),
    setPluginEnabled: vi.fn(async () => {}),
    setPluginMcpServerEnabled: vi.fn(async () => {}),
    removePlugin: vi.fn(async () => {}),
    reloadPlugins: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    reloadSession: vi.fn(async () => ({})),
    activateSkill: vi.fn(async () => {}),
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
  const interactiveAgentScope = new AsyncLocalStorage<string>();
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
    exportSession: vi.fn(async () => ({
      zipPath: '/tmp/fake-session.zip',
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    })),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    get interactiveAgentId() {
      return interactiveAgentScope.getStore() ?? 'main';
    },
    withInteractiveAgent: vi.fn((agentId: string, fn: () => unknown) => {
      return interactiveAgentScope.run(agentId, fn);
    }),
    getExperimentalFeatures: vi.fn(async () => []),
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      submitFeedback: vi.fn(
        async (): Promise<
          { kind: 'ok'; feedbackId: number } | { kind: 'error'; status?: number; message: string }
        > => ({
          kind: 'ok',
          feedbackId: 3,
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

async function confirmUndoSelection(driver: MessageDriver): Promise<void> {
  await vi.waitFor(() => {
    expect(driver.state.editorContainer.children[0]).toBeInstanceOf(UndoSelectorComponent);
  });
  (driver.state.editorContainer.children[0] as UndoSelectorComponent).handleInput('\r');
}

function renderActivity(driver: MessageDriver): string {
  return driver.state.activityContainer.render(120).join('\n');
}

function renderBtwPanel(driver: MessageDriver): string {
  return driver.state.btwPanelContainer.render(120).join('\n');
}

function getMountedBtwPanel(driver: MessageDriver): BtwPanelComponent {
  const panel = driver.state.btwPanelContainer.children.find(
    (child) => child instanceof BtwPanelComponent,
  );
  if (panel === undefined) throw new Error('Expected a mounted /btw panel.');
  return panel;
}

async function openBtwPanel(
  driver: MessageDriver,
  session: ReturnType<typeof makeSession>,
  prompt = 'side question',
): Promise<void> {
  driver.handleUserInput(`/btw ${prompt}`);
  await vi.waitFor(() => {
    expect(session.startBtw).toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
  });
}

function setTerminalRows(driver: MessageDriver, rows: number): void {
  Object.defineProperty(driver.state.terminal, 'rows', {
    configurable: true,
    get: () => rows,
  });
}

function setTerminalColumns(driver: MessageDriver, columns: number): void {
  Object.defineProperty(driver.state.terminal, 'columns', {
    configurable: true,
    get: () => columns,
  });
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

async function makeExportedSessionZip(content = 'session zip'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-code-feedback-export-'));
  tempDirs.push(dir);
  const zipPath = join(dir, 'session.zip');
  await writeFile(zipPath, content);
  return zipPath;
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

    driver.state.editor.handleInput('\u001F');
    delete process.env['VISUAL'];
    delete process.env['EDITOR'];
    driver.state.editor.onOpenExternalEditor?.();
    driver.state.editor.onToggleToolExpand?.();
    driver.state.editor.onTextPaste?.();

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

  it('dispatches /reload-tui without reloading the active session', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    await writeFile(
      join(homeDir, 'tui.toml'),
      `
theme = "light"

[editor]
command = "vim"
`,
      'utf-8',
    );
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();
    session.reloadSession.mockClear();

    driver.handleUserInput('/reload-tui');

    await vi.waitFor(() => {
      expect(driver.state.appState.theme).toBe('light');
    });
    expect(driver.state.appState.editorCommand).toBe('vim');
    expect(session.reloadSession).not.toHaveBeenCalled();
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'reload-tui' });
  });

  it('dispatches /reload through session reload and applies tui.toml', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    await writeFile(join(homeDir, 'tui.toml'), 'theme = "light"\n', 'utf-8');
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();
    session.reloadSession.mockClear();
    driver.handleUserInput('hello before reload');
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/reload');

    await vi.waitFor(() => {
      expect(session.reloadSession).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(driver.state.appState.theme).toBe('light');
    });
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'reload' });
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('hello before reload');
    expect(transcript).toContain('Session reloaded.');
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
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'none');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
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
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
  });

  it('submits text feedback before preparing requested attachments', async () => {
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
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'logs');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([{ id: 'ses-1', sessionDir: '/tmp/session-a' }] as never);

    const zipPath = await makeExportedSessionZip();
    let resolveExport!: () => void;
    const exportBlocked = new Promise<{
      zipPath: string;
      entries: string[];
      sessionDir: string;
      manifest: Record<string, never>;
    }>((resolve) => {
      resolveExport = () => {
        resolve({
          zipPath,
          entries: ['manifest.json', 'state.json'],
          sessionDir: '/tmp/session-a',
          manifest: {},
        });
      };
    });
    harness.exportSession.mockImplementationOnce(() => exportBlocked);

    let settled = false;
    const command = handleFeedbackCommand(feedbackDriver as any).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(harness.exportSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ses-1',
          includeGlobalLog: true,
          version: '0.0.0-test',
        }),
      );
    });
    expect(harness.auth.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'useful feedback' }),
    );
    expect(harness.auth.submitFeedback.mock.invocationCallOrder[0]).toBeLessThan(
      harness.exportSession.mock.invocationCallOrder[0]!,
    );
    expect(settled).toBe(false);

    resolveExport();
    await command;
  });

  it('waits for the codebase upload to finish before returning', async () => {
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
    vi.mocked(scanCodebase).mockReset();
    harness.exportSession.mockReset();
    vi.mocked(packageCodebase).mockReset();
    vi.mocked(uploadArchive).mockReset();
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([
      { id: 'ses-1', sessionDir: '/tmp/session-a' },
    ] as never);

    vi.mocked(scanCodebase).mockResolvedValueOnce({
      root: '/tmp/proj-a',
      files: [{ path: 'keep.ts', size: 4 }],
      fingerprint: 'fp-123',
      usedGitIgnore: false,
    } as any);
    const sessionZipPath = await makeExportedSessionZip();
    harness.exportSession.mockResolvedValueOnce({
      zipPath: sessionZipPath,
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    });
    vi.mocked(packageCodebase).mockResolvedValueOnce({
      path: '/tmp/fake-codebase.zip',
      size: 4,
      sha256: 'hash-123',
      fingerprint: 'fp-123',
      fileCount: 1,
    });

    let resolveCodebaseUpload!: () => void;
    const codebaseUploadBlocked = new Promise<void>((resolve) => {
      resolveCodebaseUpload = resolve;
    });
    vi.mocked(uploadArchive).mockImplementation((_api, archive) => {
      if (archive.path === sessionZipPath) return Promise.resolve();
      return codebaseUploadBlocked;
    });

    let settled = false;
    const command = handleFeedbackCommand(feedbackDriver as any).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(uploadArchive).toHaveBeenCalledTimes(2);
    });
    expect(settled).toBe(false);

    resolveCodebaseUpload();
    await command;
    expect(settled).toBe(true);
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: sessionZipPath }),
      3,
      { filename: 'session.zip' },
    );
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: '/tmp/fake-codebase.zip' }),
      3,
      { filename: 'repo.zip' },
    );
    expect(harness.auth.submitFeedback).toHaveBeenCalledWith(
      expect.not.objectContaining({ info: expect.anything() }),
    );
  });

  it('uploads session logs when codebase scanning fails but the session directory is available', async () => {
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
    vi.mocked(scanCodebase).mockReset();
    harness.exportSession.mockReset();
    vi.mocked(packageCodebase).mockReset();
    vi.mocked(uploadArchive).mockReset();
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([{ id: 'ses-1', sessionDir: '/tmp/session-a' }] as never);
    const sessionZipPath = await makeExportedSessionZip();
    vi.mocked(scanCodebase).mockRejectedValueOnce(new Error('scan failed'));
    harness.exportSession.mockResolvedValueOnce({
      zipPath: sessionZipPath,
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    });

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.exportSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ses-1', includeGlobalLog: true }),
    );
    expect(packageCodebase).not.toHaveBeenCalled();
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: sessionZipPath }),
      3,
      { filename: 'session.zip' },
    );
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
  });

  it('tells the user when feedback is sent but codebase packaging fails', async () => {
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
    vi.mocked(scanCodebase).mockReset();
    vi.mocked(packageCodebase).mockReset();
    harness.exportSession.mockReset();
    vi.mocked(uploadArchive).mockReset();
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([{ id: 'ses-1', sessionDir: '/tmp/session-a' }] as never);
    const sessionZipPath = await makeExportedSessionZip();

    vi.mocked(scanCodebase).mockResolvedValueOnce({
      root: '/tmp/proj-a',
      files: [{ path: 'keep.ts', size: 4 }],
      fingerprint: 'fp-123',
      usedGitIgnore: false,
    } as any);
    harness.exportSession.mockResolvedValueOnce({
      zipPath: sessionZipPath,
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    });
    vi.mocked(packageCodebase).mockRejectedValueOnce(new Error('zip failed'));

    await handleFeedbackCommand(feedbackDriver as any);

    const calls = harness.auth.submitFeedback.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]?.[0]?.['info']).toBeUndefined();
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: sessionZipPath }),
      3,
      { filename: 'session.zip' },
    );
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
  });

  it('tells the user when the codebase upload fails', async () => {
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
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });

    vi.mocked(scanCodebase).mockResolvedValueOnce({
      root: '/tmp/proj-a',
      files: [{ path: 'keep.ts', size: 4 }],
      fingerprint: 'fp-123',
      usedGitIgnore: false,
    } as any);
    vi.mocked(packageCodebase).mockResolvedValueOnce({
      path: '/tmp/fake-codebase.zip',
      size: 4,
      sha256: 'hash-123',
      fingerprint: 'fp-123',
      fileCount: 1,
    });
    vi.mocked(uploadArchive).mockRejectedValueOnce(new Error('upload failed'));

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).toHaveBeenCalledOnce();
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
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
    vi.mocked(promptFeedbackInput).mockImplementation(async () => ({ value: 'useful feedback' }));
    vi.mocked(promptFeedbackAttachment).mockImplementation(async () => 'none');
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

    for (const command of ['/new', '/sessions']) {
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
        thinkingEffort: 'off',
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
        transport: 'stdio' | 'http' | 'sse';
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

  it('keeps the transcript intact when undo RPC fails', async () => {
    const session = makeSession({
      undoHistory: vi.fn(async () => {
        throw new Error('core rpc unavailable');
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });
    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Error: Failed to undo: core rpc unavailable',
      );
    });

    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('hello');
  });

  it('does not duplicate welcome after undoing the only turn', async () => {
    const { driver } = await makeDriver();

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(driver.state.transcriptEntries).toEqual([]);
    });

    expect(
      driver.state.transcriptContainer.children.filter(
        (child) => child instanceof WelcomeComponent,
      ),
    ).toHaveLength(1);
  });

  it('keeps command notices that are not part of the undone context', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/auto on');

    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Auto mode: ON');
    });

    driver.handleUserInput('/undo 10');
    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Cannot undo 10 prompts; only 1 prompt can be undone in the active context.',
      );
    });

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('Cannot undo 10 prompts');
    expect(transcript).toContain('Auto mode: ON');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('removes turn-scoped background status entries and restores welcome', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';
    driver.sessionEventHandler.handleEvent(
      {
        type: 'background.task.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        info: {
          kind: 'process',
          taskId: 'bash-bg123456',
          command: 'npm test',
          description: 'Run tests in background',
          status: 'running',
          pid: 1234,
          exitCode: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      } as Event,
      () => {},
    );

    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('bash task started in background');
      expect(transcript).toContain('Run tests in background');
    });

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    const transcript = stripSgr(renderTranscript(driver));
    expect(driver.state.transcriptEntries).toEqual([]);
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('bash task started in background');
    expect(transcript).not.toContain('Run tests in background');
    expect(
      driver.state.transcriptContainer.children.filter(
        (child) => child instanceof WelcomeComponent,
      ),
    ).toHaveLength(1);
  });

  it('removes AgentSwarm progress from undone turns', async () => {
    const { driver, session } = await makeDriver();
    const sendQueued = vi.fn();

    driver.handleUserInput('launch swarm');
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    let transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('launch swarm');
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Review changed files');

    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('launch swarm');
    expect(transcript).not.toContain('Agent Swarm');
    expect(transcript).not.toContain('Review changed files');
  });

  it('removes approval notices from undone turns', async () => {
    const { driver, session } = await makeDriver();
    const approvalHandler = vi.mocked(session.setApprovalHandler).mock.calls[0]?.[0] as
      | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
      | undefined;
    if (approvalHandler === undefined) throw new Error('expected approval handler');

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';
    const response = approvalHandler({
      turnId: 1,
      toolCallId: 'call_bash',
      toolName: 'Bash',
      action: 'Run shell command',
      display: {
        kind: 'generic',
        summary: 'Run shell command',
        detail: { command: 'echo ok', description: 'Run a shell command' },
      },
    });

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(ApprovalPanelComponent);
    });
    (driver.state.editorContainer.children[0] as ApprovalPanelComponent).handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });

    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Approved: Run shell command');
    });

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('Approved: Run shell command');
  });

  it('removes debug timing status from undone turns', async () => {
    const { driver, session } = await makeDriver();
    const previousDebug = process.env['KIMI_CODE_DEBUG'];
    process.env['KIMI_CODE_DEBUG'] = '1';
    try {
      driver.handleUserInput('hello');
      driver.sessionEventHandler.handleEvent(
        {
          type: 'turn.step.completed',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          step: 1,
          llmFirstTokenLatencyMs: 120,
          llmStreamDurationMs: 800,
        } as Event,
        () => {},
      );

      await vi.waitFor(() => {
        expect(stripSgr(renderTranscript(driver))).toContain('[Debug]');
      });

      driver.state.appState.streamingPhase = 'idle';
      driver.handleUserInput('/undo');
      await confirmUndoSelection(driver);

      await vi.waitFor(() => {
        expect(session.undoHistory).toHaveBeenCalledWith(1);
      });

      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).not.toContain('hello');
      expect(transcript).not.toContain('[Debug]');
    } finally {
      if (previousDebug === undefined) {
        delete process.env['KIMI_CODE_DEBUG'];
      } else {
        process.env['KIMI_CODE_DEBUG'] = previousDebug;
      }
    }
  });

  it('undoes multiple turns when a count is provided', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('first');
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('second');
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('third');
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo 2');

    await vi.waitFor(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(2);
    });

    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'first',
      }),
    ]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('first');
    expect(transcript).not.toContain('second');
    expect(transcript).not.toContain('third');
  });

  it('rejects invalid undo counts without changing context', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo 0');

    await vi.waitFor(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Error: Usage: /undo [count], where count is a positive integer.',
      );
    });

    expect(session.undoHistory).not.toHaveBeenCalled();
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
  });

  it('undoes from the real user turn when the last skill activation came from the model', async () => {
    const { driver } = await makeDriver();

    driver.handleUserInput('hello');
    driver.sessionEventHandler.handleEvent(
      {
        type: 'skill.activated',
        agentId: 'main',
        activationId: 'act-model',
        skillName: 'review',
        trigger: 'model-tool',
      } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(driver.state.transcriptEntries).toEqual([]);
    });

    expect(driver.state.transcriptEntries).toEqual([]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('review');
  });

  it('keeps user-slash skill activations as undo anchors', async () => {
    const { driver } = await makeDriver();

    driver.handleUserInput('hello');
    driver.sessionEventHandler.handleEvent(
      {
        type: 'skill.activated',
        agentId: 'main',
        activationId: 'act-user',
        skillName: 'review',
        trigger: 'user-slash',
      } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await vi.waitFor(() => {
      expect(driver.state.transcriptEntries).toEqual([
        expect.objectContaining({
          kind: 'user',
          content: 'hello',
        }),
      ]);
    });

    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('hello');
    expect(transcript).not.toContain('review');
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
    driver.state.editor.setText('draft while streaming');
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(driver.state.editor.getText()).toBe('draft while streaming');

    session.cancel.mockClear();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('');
    driver.state.editor.onCtrlC?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it('clears streaming editor text before cancelling the active turn on Ctrl-C', async () => {
    const { driver, session } = await makeDriver();

    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft while streaming');

    driver.state.editor.onCtrlC?.();

    expect(driver.state.editor.getText()).toBe('');
    expect(session.cancel).not.toHaveBeenCalled();
    expect(driver.state.appState.streamingPhase).toBe('waiting');

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

  it('queues bash input with mode bash while a turn is streaming', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('ls');

    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'ls', agentId: 'main', mode: 'bash' },
    ]);
  });

  it('dispatches a queued bash item to runShellCommand instead of prompt', async () => {
    const runShellCommand = vi.fn(async () => ({ stdout: '', stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver } = await makeDriver(session);

    driver.sendQueuedMessage(session, { text: 'ls', mode: 'bash' });
    await Promise.resolve();

    expect(runShellCommand).toHaveBeenCalledWith(
      'ls',
      expect.objectContaining({ commandId: expect.any(String) }),
    );
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('persists bash input to input history with a leading !', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('ls');

    expect(driver.persistInputHistory).toHaveBeenCalledWith('!ls');
  });

  it('persists normal input to input history', async () => {
    const { driver } = await makeDriver();

    driver.handleUserInput('hello');

    expect(driver.persistInputHistory).toHaveBeenCalledWith('hello');
  });

  it('does not steer queued bash commands, keeping them queued', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [
      { text: 'ls', agentId: 'main', mode: 'bash' },
      { text: 'focus on tests', agentId: 'main' },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith('focus on tests');
    expect(driver.state.queuedMessages).toEqual([
      { text: 'ls', agentId: 'main', mode: 'bash' },
    ]);
  });

  it('does not steer while a shell command is running', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'shell';
    driver.state.queuedMessages = [{ text: 'summarize the output', agentId: 'main' }];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'summarize the output', agentId: 'main' },
    ]);
  });

  it('does not steer the editor draft while it is in bash mode', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.inputMode = 'bash';
    driver.state.editor.setText('ls');

    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.editor.getText()).toBe('ls');
  });

  it('drains a queued image message with its media parts', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput(`describe ${attachment.placeholder}`);

    expect(session.prompt).not.toHaveBeenCalled();
    const queued = driver.state.queuedMessages[0];
    expect(queued?.parts).toEqual([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);

    driver.sendQueuedMessage(session, queued!);

    expect(session.prompt).toHaveBeenCalledWith([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
  });

  it('steers editor image input as media parts', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.editor.setText(`check ${attachment.placeholder}`);

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'check ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
  });

  it('steers queued image messages with their media parts', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.queuedMessages = [
      {
        text: `look ${attachment.placeholder}`,
        agentId: 'main',
        parts: [
          { type: 'text', text: 'look ' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
        ],
        imageAttachmentIds: [attachment.id],
      },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'look ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('steers consecutive image-only messages without a whitespace-only separator part', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const first = imageStore.addImage(new Uint8Array([0xaa]), 'image/png', 1, 1);
    const second = imageStore.addImage(new Uint8Array([0xbb]), 'image/png', 1, 1);
    const imagePart = (bytes: Uint8Array) => ({
      type: 'image_url' as const,
      imageUrl: { url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` },
    });
    driver.state.queuedMessages = [
      {
        text: first.placeholder,
        agentId: 'main',
        parts: [imagePart(first.bytes)],
        imageAttachmentIds: [first.id],
      },
      {
        text: second.placeholder,
        agentId: 'main',
        parts: [imagePart(second.bytes)],
        imageAttachmentIds: [second.id],
      },
    ];

    driver.state.editor.onCtrlS?.();

    // normalizePromptInput rejects whitespace-only text parts, so the
    // item separator must not become a standalone `{type:'text',text:'\n\n'}`
    // between two image parts.
    expect(session.steer).toHaveBeenCalledWith([imagePart(first.bytes), imagePart(second.bytes)]);
  });

  it('steers a media item followed by plain text with a blank-line separator', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.queuedMessages = [
      {
        text: `look ${attachment.placeholder}`,
        agentId: 'main',
        parts: [
          { type: 'text', text: 'look ' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
        ],
        imageAttachmentIds: [attachment.id],
      },
      { text: 'focus on tests', agentId: 'main' },
    ];

    driver.state.editor.onCtrlS?.();

    // The historical '\n\n' item separator merges into the following text
    // part (legal for normalizePromptInput) instead of vanishing after a
    // media part.
    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'look ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
      { type: 'text', text: '\n\nfocus on tests' },
    ]);
  });

  it('steers plain text followed by a media item with a blank-line separator', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.queuedMessages = [
      { text: 'hello', agentId: 'main' },
      {
        text: attachment.placeholder,
        agentId: 'main',
        parts: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } }],
        imageAttachmentIds: [attachment.id],
      },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'hello\n\n' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
  });

  it('shows an error instead of throwing when skill media materialization fails', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    // The pasted video's source file vanished before submit — the cache copy
    // throws, and it must surface as a TUI error, not an unhandled rejection.
    const missing = imageStore.addVideo('video/quicktime', '/tmp/kimi-missing-source.mov');

    (
      driver as unknown as {
        sendSkillActivation(s: unknown, name: string, args: string): void;
      }
    ).sendSkillActivation(session, 'test', `look ${missing.placeholder}`);

    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
  });

  it('shows an error instead of throwing when plugin command media materialization fails', async () => {
    const activatePluginCommand = vi.fn(async () => {});
    const session = makeSession({ activatePluginCommand });
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const missing = imageStore.addVideo('video/mp4', '/tmp/kimi-missing-source.mp4');

    (
      driver as unknown as {
        activatePluginCommand(s: unknown, pluginId: string, command: string, args: string): void;
      }
    ).activatePluginCommand(session, 'plug', 'cmd', missing.placeholder);

    expect(activatePluginCommand).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
  });

  it('keeps the queue and draft intact when steer media extraction fails', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const missing = imageStore.addVideo('video/quicktime', '/tmp/kimi-missing-source.mov');
    driver.state.queuedMessages = [{ text: 'queued note', agentId: 'main' }];
    driver.state.editor.setText(`look ${missing.placeholder}`);

    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'queued note', agentId: 'main' }]);
    expect(driver.state.editor.getText()).toBe(`look ${missing.placeholder}`);
    expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
  });

  it('recalls a queued bash command back into bash mode on Up', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [{ text: 'ls', agentId: 'main', mode: 'bash' }];
    // After a bash command is queued the editor is reset to prompt mode.
    driver.state.editor.inputMode = 'prompt';
    driver.state.appState.inputMode = 'prompt';

    const handled = driver.state.editor.onUpArrowEmpty?.();

    expect(handled).toBe(true);
    expect(driver.state.editor.getText()).toBe('ls');
    expect(driver.state.editor.inputMode).toBe('bash');
    expect(driver.state.appState.inputMode).toBe('bash');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('recalls a queued prompt message in prompt mode on Up', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [{ text: 'hello', agentId: 'main' }];
    driver.state.editor.inputMode = 'bash';
    driver.state.appState.inputMode = 'bash';

    const handled = driver.state.editor.onUpArrowEmpty?.();

    expect(handled).toBe(true);
    expect(driver.state.editor.getText()).toBe('hello');
    expect(driver.state.editor.inputMode).toBe('prompt');
    expect(driver.state.appState.inputMode).toBe('prompt');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('echoes a bash command with a $ prompt in the transcript', async () => {
    const runShellCommand = vi.fn(async () => ({ stdout: '', stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver, harness } = await makeDriver(session);
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('ls');
    await Promise.resolve();

    expect(harness.track).toHaveBeenCalledWith('shell_command', undefined);

    const transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('$ ls');
    expect(transcript).not.toContain('! ls');
  });

  it('renders cron fired events as distinct transcript entries', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'cron.fired',
        agentId: 'main',
        sessionId: 'ses-1',
        origin: {
          kind: 'cron_job',
          jobId: 'deadbeef',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
        prompt: 'Remind the user: this is a once-per-minute reminder',
      } as Event,
      vi.fn(),
    );

    const entry = driver.state.transcriptEntries.at(-1);
    expect(entry).toMatchObject({
      kind: 'cron',
      content: 'Remind the user: this is a once-per-minute reminder',
      cronData: {
        jobId: 'deadbeef',
        cron: '* * * * *',
        coalescedCount: 1,
        stale: false,
      },
    });

    const transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('Scheduled reminder fired');
    expect(transcript).toContain('* * * * *');
    expect(transcript).toContain('Remind the user: this is a once-per-minute reminder');
    expect(transcript).not.toContain('<cron-fire');
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
      expect(updateSpy).toHaveBeenLastCalledWith('abc', { transient: true });
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

  it('clears editor text before cancelling compaction on Ctrl-C', async () => {
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
    driver.state.editor.setText('draft while compacting');

    driver.state.editor.onCtrlC?.();

    expect(driver.state.editor.getText()).toBe('');
    expect(session.cancelCompaction).not.toHaveBeenCalled();
    expect(driver.state.appState.isCompacting).toBe(true);

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

  it('stores the live compaction summary and expands it with tool output expansion', async () => {
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

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        result: {
          summary: 'Keep the src/tui compaction notes.',
          compactedCount: 4,
          tokensBefore: 120,
          tokensAfter: 24,
        },
      } as Event,
      sendQueued,
    );

    const collapsed = driver.state.transcriptContainer.render(120).map(stripSgr).join('\n');
    expect(collapsed).toContain('Compaction complete');
    expect(collapsed).not.toContain('Keep the src/tui compaction notes.');

    driver.state.editor.onToggleToolExpand?.();

    const expanded = driver.state.transcriptContainer.render(120).map(stripSgr).join('\n');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(expanded).toContain('Keep the src/tui compaction notes.');
  });

  it('honors existing tool output expansion when a compaction block is created', async () => {
    const { driver } = await makeDriver();
    const sendQueued = vi.fn();

    driver.state.editor.onToggleToolExpand?.();
    expect(driver.state.toolOutputExpanded).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        result: {
          summary: 'Keep the src/tui compaction notes.',
          compactedCount: 4,
          tokensBefore: 120,
          tokensAfter: 24,
        },
      } as Event,
      sendQueued,
    );

    const transcript = driver.state.transcriptContainer.render(120).map(stripSgr).join('\n');
    expect(transcript).toContain('Compaction complete');
    expect(transcript).toContain('Keep the src/tui compaction notes.');
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

  it('starts /btw through a forked side agent without changing the main busy state', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    harness.track.mockClear();
    driver.state.appState.streamingPhase = 'composing';
    driver.state.livePane.mode = 'thinking';

    driver.handleUserInput('/btw What are you working on right now?');

    await vi.waitFor(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledWith('What are you working on right now?');
    });
    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.appState.streamingPhase).toBe('composing');
    expect(driver.state.livePane.mode).toBe('thinking');
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'btw' });
  });

  it('opens /btw without a question and sends the first panel input to a side agent', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/btw');

    await vi.waitFor(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(stripSgr(renderBtwPanel(driver))).toContain('Ready for a side question...');

    driver.handleUserInput('What are you working on right now?');

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledWith('What are you working on right now?');
    });
    expect(session.steer).not.toHaveBeenCalled();
    expect(stripSgr(renderBtwPanel(driver))).toContain('Q: What are you working on right now?');
  });

  it('cancels an unused /btw side agent when closing an empty panel', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/btw');

    await vi.waitFor(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledOnce();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
  });

  it('renders /btw output in a dedicated panel instead of an Agent tool card', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session, 'What are you working on right now?');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'I am implementing the dedicated /btw panel.',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
    expect(driver.state.btwPanelContainer.render(120)[0]?.trim()).toBe('');
    expect(getMountedBtwPanel(driver).isRunning()).toBe(false);
    expect(driver.state.editor.focused).toBe(true);

    const transcript = stripSgr(renderTranscript(driver));
    const panel = stripSgr(renderBtwPanel(driver));
    const editorTopBorder = stripSgr(driver.state.editor.render(80)[0] ?? '');
    expect(panel).toContain('BTW ─ Esc close');
    expect(panel).not.toContain('ctrl+o expand');
    expect(editorTopBorder.startsWith('├')).toBe(true);
    expect(editorTopBorder.endsWith('┤')).toBe(true);

    driver.state.editor.handleInput('/');
    const highlightedEditorTopBorder = stripSgr(driver.state.editor.render(80)[0] ?? '');
    expect(highlightedEditorTopBorder.startsWith('╭')).toBe(true);
    expect(highlightedEditorTopBorder.endsWith('╮')).toBe(true);
    expect(panel).not.toContain('BTW done');
    expect(panel).not.toContain('BTW running');
    expect(panel).not.toContain('BTW failed');
    expect(panel).not.toContain('Ask:');
    expect(panel).not.toContain('Type follow-up');
    expect(panel).toContain('Q: What are you working on right now?');
    expect(panel).toContain('I am implementing the dedicated /btw panel.');
    expect(panel).not.toContain('Agent');
    expect(transcript).not.toContain('BTW');
    expect(transcript).not.toContain('Esc close');
    expect(transcript).not.toContain('I am implementing the dedicated /btw panel.');
  });

  it('keeps the /btw panel closest to the input after later transcript output', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'side answer',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        origin: { kind: 'user' },
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'main answer after btw',
      } as Event,
      () => {},
    );
    driver.streamingUI.flushNow();

    const transcript = stripSgr(renderTranscript(driver));
    const panel = stripSgr(renderBtwPanel(driver));
    const rootChildren = driver.state.ui.children;
    expect(rootChildren.indexOf(driver.state.btwPanelContainer)).toBe(
      rootChildren.indexOf(driver.state.editorContainer) - 1,
    );
    expect(transcript).toContain('main answer after btw');
    expect(transcript).not.toContain('side answer');
    expect(panel).toContain('BTW');
    expect(panel).not.toContain('BTW done');
    expect(panel).not.toContain('BTW running');
    expect(panel).not.toContain('BTW failed');
    expect(panel).toContain('side answer');
    expect(panel).not.toContain('main answer after btw');
  });

  it('renders only the tail of /btw thinking output', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n'),
      } as Event,
      () => {},
    );

    const transcript = stripSgr(renderTranscript(driver));
    const panel = stripSgr(renderBtwPanel(driver));
    expect(transcript).not.toContain('line7');
    expect(panel).not.toContain('line1');
    expect(panel).not.toContain('line5');
    expect(panel).toContain('line6');
    expect(panel).toContain('line7');
  });

  it('renders /btw body at its actual content height when under the cap', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    const lines = getMountedBtwPanel(driver).render(80).map(stripSgr);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('Q: side question');
    expect(lines.join('\n')).toContain('Waiting for answer...');
  });

  it('keeps /btw panel height stable when final output is shorter than thinking', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'thinking line 1\nthinking line 2',
      } as Event,
      () => {},
    );

    const mountedPanel = getMountedBtwPanel(driver);
    const thinkingLines = mountedPanel.render(80).map(stripSgr);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'final answer',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    const finalLines = mountedPanel.render(80).map(stripSgr);
    expect(finalLines).toHaveLength(thinkingLines.length);
    expect(finalLines.join('\n')).toContain('final answer');
    expect(finalLines.at(-1)).toMatch(/^│\s+│$/);
  });

  it('caps /btw height to one-third of the terminal and supports scrolling', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    setTerminalRows(driver, 15);
    await openBtwPanel(driver, session, 'question 1');

    const panel = getMountedBtwPanel(driver);
    panel.appendAnswer('answer 1');
    panel.markDone();
    for (let i = 2; i <= 8; i++) {
      panel.submit(`question ${String(i)}`);
      panel.appendAnswer(`answer ${String(i)}`);
      panel.markDone();
    }

    const collapsed = panel.render(80).map(stripSgr);
    expect(collapsed).toHaveLength(5);
    expect(collapsed.join('\n')).toContain('BTW ─ Esc close · ↑↓ scroll');
    expect(collapsed.join('\n')).not.toContain('ctrl+o expand');
    expect(collapsed.join('\n')).toContain('question 8');
    expect(collapsed.join('\n')).toContain('answer 8');
    expect(collapsed.join('\n')).not.toContain('question 1');

    driver.state.editor.setText('draft main input');
    const collapsedWithInput = panel.render(80).map(stripSgr);
    expect(collapsedWithInput.join('\n')).toContain('BTW ─ Esc close');
    expect(collapsedWithInput.join('\n')).not.toContain('↑↓ scroll');
    driver.state.editor.setText('');

    const requestRender = vi.mocked(driver.state.ui.requestRender);
    requestRender.mockClear();
    for (let i = 0; i < 20; i++) {
      driver.state.editor.handleInput('\u001B[A');
    }
    const scrolledUp = panel.render(80).map(stripSgr);
    expect(requestRender).toHaveBeenCalled();
    expect(scrolledUp.join('\n')).toContain('question 1');
    expect(scrolledUp.join('\n')).not.toContain('answer 8');

    panel.appendAnswer('\nstreamed tail while scrolled');
    expect(panel.render(80).map(stripSgr)).toEqual(scrolledUp);

    requestRender.mockClear();
    for (let i = 0; i < 20; i++) {
      driver.state.editor.handleInput('\u001B[B');
    }
    const scrolledDown = panel.render(80).map(stripSgr);
    expect(requestRender).toHaveBeenCalled();
    expect(scrolledDown.join('\n')).toContain('question 8');
    expect(scrolledDown.join('\n')).toContain('answer 8');
    expect(scrolledDown.join('\n')).toContain('streamed tail while scrolled');

    setTerminalRows(driver, 4);
    const tiny = panel.render(80).map(stripSgr);
    expect(tiny).toHaveLength(3);
    expect(tiny.join('\n')).not.toContain('ctrl+o expand');
    expect(tiny.join('\n')).toContain('answer 8');

    requestRender.mockClear();
    driver.state.editor.onToggleToolExpand?.();
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(panel.render(80).map(stripSgr)).toEqual(tiny);
  });

  it('cancels and closes a running /btw panel on Escape', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(true);
    expect(driver.state.editor.focused).toBe(true);

    const requestRender = vi.mocked(driver.state.ui.requestRender);
    requestRender.mockClear();
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledOnce();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(requestRender.mock.calls.at(-1)).toEqual([true]);
    const editorTopBorder = stripSgr(driver.state.editor.render(80)[0] ?? '');
    expect(editorTopBorder.startsWith('╭')).toBe(true);
    expect(editorTopBorder.endsWith('╮')).toBe(true);
    expect(driver.state.editor.focused).toBe(true);
  });

  it('cancels a running /btw panel on Ctrl-C without closing it or cancelling main streaming', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    const cancelledAgentIds: string[] = [];
    session.cancel.mockImplementation(async () => {
      cancelledAgentIds.push(harness.interactiveAgentId);
    });
    await openBtwPanel(driver, session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft main input');

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(true);

    driver.state.editor.onCtrlC?.();

    expect(session.cancel).toHaveBeenCalledOnce();
    expect(cancelledAgentIds).toEqual(['agent-btw']);
    expect(getMountedBtwPanel(driver)).toBe(panel);
    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
    expect(driver.state.editor.focused).toBe(true);
    expect(driver.state.editor.getText()).toBe('draft main input');
    expect(driver.state.appState.streamingPhase).toBe('waiting');
  });

  it('preserves rendered /btw output when a running panel is cancelled', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'partial side answer',
      } as Event,
      () => {},
    );

    driver.state.editor.onCtrlC?.();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'cancelled',
      } as Event,
      () => {},
    );

    const panel = stripSgr(renderBtwPanel(driver));
    expect(panel).toContain('partial side answer');
    expect(panel).toContain('Interrupted by user');
  });

  it('cancels a running /btw panel when starting a new session clears it', async () => {
    const initialSession = makeSession({ id: 'ses-initial' });
    const nextSession = makeSession({ id: 'ses-next' });
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(initialSession)
      .mockResolvedValueOnce(nextSession);
    const { driver, harness } = await makeDriver(initialSession, { createSession });
    const cancelledAgentIds: string[] = [];
    initialSession.cancel.mockImplementation(async () => {
      cancelledAgentIds.push(harness.interactiveAgentId);
    });
    await openBtwPanel(driver, initialSession);

    driver.handleUserInput('/new');

    await vi.waitFor(() => {
      expect(driver.getCurrentSessionId()).toBe('ses-next');
    });
    expect(initialSession.cancel).toHaveBeenCalledOnce();
    expect(cancelledAgentIds).toEqual(['agent-btw']);
    expect(nextSession.cancel).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
  });

  it('closes a completed /btw panel on Ctrl-C without cancelling main streaming', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft main input');

    expect(getMountedBtwPanel(driver).isRunning()).toBe(false);

    driver.state.editor.onCtrlC?.();

    expect(session.cancel).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(driver.state.editor.focused).toBe(true);
    expect(driver.state.editor.getText()).toBe('draft main input');
    expect(driver.state.appState.streamingPhase).toBe('waiting');
  });

  it('closes a completed /btw panel on Escape without cancelling it', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(false);
    expect(driver.state.editor.focused).toBe(true);

    driver.state.editor.onEscape?.();

    expect(session.cancel).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(driver.state.editor.focused).toBe(true);
  });

  it('sends follow-up /btw input through ordinary prompt on the same side agent', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session, 'first question');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(false);
    driver.handleUserInput('follow up');

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledWith('follow up');
    });
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
    expect(driver.state.editor.focused).toBe(true);
  });

  it('keeps main input pointed at /btw while the panel is open', async () => {
    let resolveBtwPrompt: (() => void) | undefined;
    const session = makeSession({
      prompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveBtwPrompt = resolve;
          }),
      ),
    });
    const { driver, harness } = await makeDriver(session);

    await openBtwPanel(driver, session, 'slow side question');

    expect(harness.interactiveAgentId).toBe('main');
    driver.handleUserInput('follow-up while btw prompt is pending');
    driver.handleUserInput('another follow-up while btw prompt is pending');

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(driver.state.queuedMessages).toEqual([]);
    expect(driver.state.editor.getText()).toBe('another follow-up while btw prompt is pending');
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Wait for /btw to finish before sending another question.',
    );
    expect(
      countOccurrences(
        stripSgr(renderBtwPanel(driver)),
        'Wait for /btw to finish before sending another question.',
      ),
    ).toBe(2);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    expect(stripSgr(renderBtwPanel(driver))).not.toContain(
      'Wait for /btw to finish before sending another question.',
    );

    resolveBtwPrompt?.();
  });

  it('replaces a running /btw panel when another /btw command is submitted', async () => {
    const session = makeSession({
      startBtw: vi.fn()
        .mockResolvedValueOnce('agent-btw-1')
        .mockResolvedValueOnce('agent-btw-2'),
    });
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session, 'first question');

    const firstPanel = getMountedBtwPanel(driver);
    expect(firstPanel.isRunning()).toBe(true);

    driver.handleUserInput('/btw second question');

    await vi.waitFor(() => {
      expect(session.startBtw).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledWith('second question');
    });

    const secondPanel = getMountedBtwPanel(driver);
    expect(secondPanel).not.toBe(firstPanel);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(2);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw-1',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'answer from old side agent',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw-2',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'answer from new side agent',
      } as Event,
      () => {},
    );

    const renderedPanel = stripSgr(renderBtwPanel(driver));
    expect(renderedPanel).not.toContain('answer from old side agent');
    expect(renderedPanel).toContain('answer from new side agent');
  });

  it('does not run /btw without a selected model', async () => {
    const { driver, session } = await makeDriver();

    driver.state.appState.model = '';
    driver.handleUserInput('/btw');
    expect(session.startBtw).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(stripSgr(renderTranscript(driver))).toContain('LLM not set');

    driver.handleUserInput('/btw What are you doing now?');

    expect(session.startBtw).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain('LLM not set');
  });

  it('applies the effective thinking effort from status updates', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        model: 'turbo',
        thinkingEffort: 'mid',
      } as Event,
      vi.fn(),
    );

    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('mid');
  });

  it('renders swarm mode markers from /swarm commands, not tool-triggered status updates', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        swarmMode: true,
      } as Event,
      vi.fn(),
    );

    expect(driver.state.appState.swarmMode).toBe(true);
    expect(stripSgr(renderTranscript(driver))).not.toContain('Swarm activated');

    let transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Swarm activated')).toBe(0);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        swarmMode: false,
      } as Event,
      vi.fn(),
    );

    expect(driver.state.appState.swarmMode).toBe(false);
    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('Swarm deactivated');
    expect(transcript).not.toContain('Swarm ended');

    expect(countOccurrences(transcript, 'Swarm activated')).toBe(0);
    expect(countOccurrences(transcript, 'Swarm deactivated')).toBe(0);
    expect(countOccurrences(transcript, 'Swarm ended')).toBe(0);
  });

  it('renders an ended marker when a one-shot /swarm task exits', async () => {
    const { driver, session } = await makeDriver(undefined);
    driver.state.appState.permissionMode = 'auto';

    driver.handleUserInput('/swarm Ship feature X');

    await vi.waitFor(() => {
      expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    });
    await vi.waitFor(() => {
      expect(countOccurrences(stripSgr(renderTranscript(driver)), 'Swarm activated')).toBe(1);
    });
    let transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Swarm activated')).toBe(1);
    expect(transcript).not.toContain('Swarm ended');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        swarmMode: false,
      } as Event,
      vi.fn(),
    );

    expect(driver.state.appState.swarmMode).toBe(false);
    transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Swarm activated')).toBe(1);
    expect(countOccurrences(transcript, 'Swarm ended')).toBe(1);
    expect(transcript).not.toContain('Swarm deactivated');
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
    expect(transcript).not.toContain('/export-debug-zip');
  });

  it('shows a programmatic abort reason instead of reporting a user interruption', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.step.interrupted',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        step: 1,
        reason: 'aborted',
        message: 'Tool execution timed out',
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Error: Tool execution timed out');
    expect(transcript).not.toContain('Interrupted by user');
  });

  it('keeps unmessaged aborted events compatible with user interruptions', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.step.interrupted',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        step: 1,
        reason: 'aborted',
      } as Event,
      vi.fn(),
    );

    expect(stripSgr(renderTranscript(driver))).toContain('Interrupted by user');
  });

  it('appends the /export-debug-zip hint beneath session error messages', async () => {
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
    expect(transcript).toContain('If this persists, run `/export-debug-zip`');
    expect(transcript).toContain("Please don't share it publicly");
    expect(transcript).not.toContain('kimi export');
  });

  it('shows concise provider filter text for filtered session errors', async () => {
    const { driver } = await makeDriver();
    const verboseMessage =
      'The API returned a response containing only thinking content without any text or tool calls. ' +
      'This usually indicates the stream was interrupted or the output token budget was exhausted ' +
      'during reasoning. Provider stop details: finishReason=filtered, rawFinishReason=content_filter. ' +
      'The provider filtered the response before visible output was emitted. Provider: example-provider, model: example-model';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: 'ses-1',
        code: 'provider.api_error',
        message: verboseMessage,
        details: {
          finishReason: 'filtered',
          rawFinishReason: 'content_filter',
        },
        retryable: true,
      } as Event,
      vi.fn(),
    );

    const transcript = stripSgr(driver.state.transcriptContainer.render(200).join('\n'));
    expect(transcript).toContain(
      'Error: [provider.api_error] Provider filtered the response before visible output',
    );
    expect(transcript).toContain('finishReason=filtered');
    expect(transcript).toContain('rawFinishReason=content_filter');
    expect(transcript).not.toContain('only thinking content');
    expect(transcript).not.toContain('token budget');
    expect(transcript).not.toContain('stream was interrupted');
  });

  it('skips the /export-debug-zip hint when no active session id is set', async () => {
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
    expect(transcript).not.toContain('/export-debug-zip');
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

  it('renders AgentSwarm progress in the transcript instead of the tool-card body', async () => {
    const { driver } = await makeDriver();
    const sendQueued = vi.fn();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-1',
        subagentName: 'coder',
        description: 'Review changed files #1 (coder)',
        swarmIndex: 1,
        runInBackground: false,
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-2',
        subagentName: 'coder',
        description: 'Review changed files #2 (coder)',
        swarmIndex: 2,
        runInBackground: false,
      } as Event,
      sendQueued,
    );

    vi.mocked(driver.state.ui.requestRender).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        turnId: 2,
        toolCallId: 'call_read',
        name: 'Read',
        args: { path: 'src/a.ts' },
      } as Event,
      sendQueued,
    );
    expect(driver.state.ui.requestRender).toHaveBeenCalled();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        turnId: 2,
        delta: 'Reviewing src/a.ts and checking imports for regressions in detail',
      } as Event,
      sendQueued,
    );
    let transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('01 [');
    expect(transcript).toContain('Reviewing src/a.ts');

    vi.mocked(driver.state.ui.requestRender).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.suspended',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
        reason: 'Provider rate limit; subagent requeued for retry.',
      } as Event,
      sendQueued,
    );
    expect(driver.state.ui.requestRender).toHaveBeenCalled();

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('001 [');
    expect(transcript).toContain('Queued...');
    expect(transcript).not.toContain('Provider rate limit');
    expect(transcript).not.toContain('Failed');

    vi.mocked(driver.state.ui.requestRender).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.started',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
      } as Event,
      sendQueued,
    );
    expect(driver.state.ui.requestRender).toHaveBeenCalled();

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('01 [');
    expect(transcript).not.toContain('Suspended');

    vi.mocked(driver.state.ui.requestRender).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        turnId: 2,
        reason: 'completed',
      } as Event,
      sendQueued,
    );
    expect(driver.state.ui.requestRender).toHaveBeenCalled();

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Review changed files');
    expect(transcript).toContain('001 [');
    expect(transcript).toContain('Reviewing src/a.ts');
    expect(transcript).not.toContain('Completed');
    expect(transcript).toContain('002 Queued...');
    expect(transcript).not.toContain('002 [');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
        resultSummary: 'Imports are stable',
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('✓ Imports are stable');
    expect(transcript).not.toContain('Completed');
  });

  it('marks only core user-cancellation subagent failures as cancelled', async () => {
    const { driver } = await makeDriver();
    const sendQueued = vi.fn();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    for (const [index, subagentId] of ['agent-1', 'agent-2'].entries()) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'subagent.spawned',
          agentId: 'main',
          sessionId: 'ses-1',
          parentToolCallId: 'call_swarm',
          subagentId,
          subagentName: 'coder',
          description: `Review changed files #${String(index + 1)} (coder)`,
          swarmIndex: index + 1,
          runInBackground: false,
        } as Event,
        sendQueued,
      );
    }

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
        error: 'Aborted by the user',
      } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-2',
        error: 'The user manually interrupted this subagent x.',
      } as Event,
      sendQueued,
    );

    const transcript = stripSgr(driver.state.transcriptContainer.render(200).join('\n'));
    expect(transcript).toContain('⊘ Cancelled.');
    expect(transcript).toContain('✗ The user manually interrupted this subagent x.');
  });

  it('does not let later transcript entries reduce the AgentSwarm grid height', async () => {
    const { driver } = await makeDriver();
    const sendQueued = vi.fn();
    const terminalColumns = 80;
    setTerminalColumns(driver, terminalColumns);
    const outerChildren = driver.state.ui.children;
    const transcriptIndex = outerChildren.indexOf(driver.state.transcriptContainer);
    const rowsAfterTranscript = outerChildren
      .slice(transcriptIndex + 1)
      .reduce((sum, child) => sum + child.render(terminalColumns).length, 0);
    const nonGridRows = 20 - (agentSwarmGridHeightForTerminalRows(20) ?? 0);
    setTerminalRows(driver, rowsAfterTranscript + nonGridRows + 2);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
        },
      } as Event,
      sendQueued,
    );

    const swarmProgress = driver.state.transcriptContainer.children.find(
      (child): child is AgentSwarmProgressComponent => child instanceof AgentSwarmProgressComponent,
    );
    if (swarmProgress === undefined) throw new Error('expected AgentSwarm progress');

    const transcriptWidth = Math.max(1, terminalColumns - 2);
    const renderSwarm = (): string =>
      stripSgr(swarmProgress.render(transcriptWidth).join('\n'));

    expect(renderSwarm()).toContain('001 Queued...');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_read',
        name: 'Read',
        args: { path: 'src/after.ts' },
      } as Event,
      sendQueued,
    );

    const transcriptChildren = driver.state.transcriptContainer.children;
    const swarmIndex = transcriptChildren.indexOf(
      swarmProgress as (typeof transcriptChildren)[number],
    );
    expect(swarmIndex).toBeGreaterThanOrEqual(0);

    const rowsAfterSwarmInTranscript = transcriptChildren
      .slice(swarmIndex + 1)
      .reduce((sum, child) => sum + child.render(transcriptWidth).length, 0);
    expect(rowsAfterSwarmInTranscript).toBeGreaterThan(0);

    expect(renderSwarm()).toContain('001 Queued...');
    const transcript = stripSgr(
      driver.state.transcriptContainer.render(terminalColumns).join('\n'),
    );
    expect(transcript).toContain('Using Read (src/after.ts)');
  });

  it('shows AgentSwarm as completed when only some subagents fail', async () => {
    const { driver } = await makeDriver();
    const sendQueued = vi.fn();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        output: [
          '<agent_swarm_result>',
          '<summary>completed: 1, failed: 1</summary>',
          '<subagent index="1" agent_id="agent-1" outcome="completed">Imports are stable.</subagent>',
          '<subagent index="2" agent_id="agent-2" outcome="failed">Agent timed out after 30s.</subagent>',
          '</agent_swarm_result>',
        ].join('\n'),
        isError: undefined,
      } as Event,
      sendQueued,
    );

    const transcript = stripSgr(renderTranscript(driver));
    const totalStatusLine = transcript.split('\n').find((line) => line.includes('Completed.'));
    expect(totalStatusLine).toBeDefined();
    expect(totalStatusLine).not.toContain('Failed.');
    expect(transcript).toContain('✓ Imports are stable.');
    expect(transcript).toContain('✗ Agent timed out after 30s.');
  });

  it('renders AgentSwarm progress while tool args are still streaming', async () => {
    const { driver } = await makeDriver();
    const sendQueued = vi.fn();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        argumentsPart: '{"description":"Review changed files',
      } as Event,
      sendQueued,
    );

    let transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Orchestrating...');
    expect(transcript).not.toContain('01');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        argumentsPart: '","items":["src/a.ts","src/b',
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Review changed files');
    expect(transcript).toContain('001 src/a.ts');
    expect(transcript).toContain('002 src/b');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-1',
        subagentName: 'coder',
        description: 'Review changed files #1 (coder)',
        swarmIndex: 1,
        runInBackground: false,
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('001 Queued...');
    expect(transcript).not.toContain('001 [');
    expect(transcript).toContain('002 src/b');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('001 Queued...');
    expect(transcript).toContain('002 Queued...');
    expect(transcript).not.toContain('001 [');
    expect(transcript).not.toContain('002 [');
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
        thinkingEffort: 'high',
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
      expect(output).toContain('thinking high');
      expect(output).toContain('Permissions  auto');
      expect(output).toContain('Plan mode    on');
      expect(output).toContain('Context window');
      expect(output).toContain('25%');
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

  it('installs from a positional source on /plugins install after trusting it', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install ./plugins/kimi-datasource');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    await vi.waitFor(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(
        resolve('/tmp/proj-a', './plugins/kimi-datasource'),
      );
    });
  });

  it('does not install when the third-party trust prompt is dismissed', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install ./plugins/kimi-datasource');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\r'); // default option is "Exit"

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    });
    expect(session.installPlugin).not.toHaveBeenCalled();
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
            tier: 'official',
            displayName: 'Kimi Datasource',
            description: 'Datasource plugin',
            source: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
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
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    // Official loads its catalog lazily; wait for the entry to render before install.
    await vi.waitFor(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Kimi Datasource');
    });
    // The pinned Kimi WebBridge row leads the Official tab, so move down to
    // the Kimi Datasource entry before installing.
    panel.handleInput('\u001B[B');
    panel.handleInput('\r');

    await vi.waitFor(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(
        'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
      );
    });
    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Installed Demo');
      expect(transcript).toContain('Run /new or /reload to apply plugin changes.');
    });
    // Installing closes the panel so the success notice / reload tip is visible.
    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    });
  });

  it('returns to the plugin list when a marketplace install fails', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-datasource',
            tier: 'official',
            displayName: 'Kimi Datasource',
            source: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
          },
        ],
      }),
      'utf8',
    );
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = marketplacePath;
    const installPlugin = vi.fn(async () => {
      throw new Error('install failed');
    });
    const session = makeSession({ installPlugin });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins marketplace');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await vi.waitFor(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Kimi Datasource');
    });
    panel.handleInput('\r');

    // The panel must not get stuck on the one-way "Installing…" view; it should
    // return to the list so the user can retry.
    await vi.waitFor(() => {
      const rendered = stripSgr(panel.render(120).join('\n'));
      expect(rendered).toContain('Kimi Datasource');
      expect(rendered).not.toContain('Installing');
    });
  });

  it('prompts for trust before installing a third-party marketplace entry', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            description: 'Curated plugin',
            source: './superpowers',
          },
        ],
      }),
      'utf8',
    );
    const session = makeSession();
    const { driver } = await makeDriver(session);

    // Passing the marketplace path opens the panel directly on the Third-party tab.
    driver.handleUserInput(`/plugins marketplace ${marketplacePath}`);

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await vi.waitFor(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Superpowers');
    });
    panel.handleInput('\r');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    await vi.waitFor(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(join(marketplaceDir, 'superpowers'));
    });
  });

  it('restores the panel when a third-party marketplace install fails', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            source: './superpowers',
          },
        ],
      }),
      'utf8',
    );
    const installPlugin = vi.fn(async () => {
      throw new Error('install failed');
    });
    const session = makeSession({ installPlugin });
    const { driver } = await makeDriver(session);

    driver.handleUserInput(`/plugins marketplace ${marketplacePath}`);

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await vi.waitFor(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Superpowers');
    });
    panel.handleInput('\r');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    // The failed install must return the user to the marketplace panel so they
    // can retry, rather than dropping them back at the editor.
    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBe(panel);
    });
  });

  it('removes a plugin record without auto-running any cleanup skill', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins remove kimi-webbridge');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginRemoveConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginRemoveConfirmComponent;
    confirm.handleInput('\u001B[B');
    confirm.handleInput('\r');

    await vi.waitFor(() => {
      expect(session.removePlugin).toHaveBeenCalledWith('kimi-webbridge');
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('installs default marketplace entries through plain install', async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      plugins: [
        {
          id: 'kimi-datasource',
          tier: 'official',
          displayName: 'Kimi Datasource',
          description: 'Datasource plugin',
          source: './official/kimi-datasource.zip',
        },
      ],
    }))));
    const session = makeSession();
    const { driver } = await makeDriver(session);

    try {
      driver.handleUserInput('/plugins marketplace');

      await vi.waitFor(() => {
        expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
      });
      const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
      await vi.waitFor(() => {
        expect(stripSgr(panel.render(120).join('\n'))).toContain('Kimi Datasource');
      });
      // The pinned Kimi WebBridge row leads the Official tab, so move down to
      // the Kimi Datasource entry before installing.
      panel.handleInput('\u001B[B');
      panel.handleInput('\r');

      await vi.waitFor(() => {
        expect(session.installPlugin).toHaveBeenCalledWith(
          'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
        );
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(KIMI_CODE_PLUGIN_MARKETPLACE_URL);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('shows an inline Official error when the marketplace is unreachable, keeping the panel open', async () => {
    const originalFetch = globalThis.fetch;
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = 'https://example.test/marketplace.json';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const session = makeSession();
    const { driver } = await makeDriver(session);

    try {
      driver.handleUserInput('/plugins');

      // The panel opens immediately on the Installed tab — no marketplace fetch.
      await vi.waitFor(() => {
        expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
      });
      const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
      panel.handleInput('\t'); // → Official, which lazily (and unsuccessfully) loads

      await vi.waitFor(() => {
        expect(stripSgr(panel.render(120).join('\n'))).toContain(
          'Marketplace unavailable: fetch failed',
        );
      });
      // The panel stays mounted; the failure does not close /plugins.
      expect(driver.state.editorContainer.children[0]).toBe(panel);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('toggles plugins from the Installed tab with space', async () => {
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
          source: 'local-path',
        },
      ]),
      setPluginEnabled: vi.fn(async (_id: string, nextEnabled: boolean) => {
        enabled = nextEnabled;
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    panel.handleInput(' ');

    // Toggling refreshes the panel in place: it must not flash back to the
    // editor between the keypress and the refreshed panel mounting.
    expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);

    await vi.waitFor(() => {
      expect(session.setPluginEnabled).toHaveBeenCalledWith('demo', false);
    });
    await vi.waitFor(() => {
      const refreshed = stripSgr(driver.state.editorContainer.children[0]!.render(120).join('\n'));
      expect(refreshed).toContain('❯ Demo  disabled  run /reload or /new to apply');
    });
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Disabled demo. Run /reload or /new to apply.',
    );
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
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    panel.handleInput('m');

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
    expect(out).toContain('❯ data  disabled  run /reload or /new to apply');
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Disabled MCP server data for kimi-datasource. Run /reload or /new to apply.',
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
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0];
    const pickerOutput = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
    expect(pickerOutput).toMatch(/Kimi K2\s+Kimi Code ← current/);
    expect(pickerOutput).toMatch(/❯ Kimi Turbo\s+Kimi Code/);
    (picker as TabbedModelSelectorComponent).handleInput('t');
    (picker as TabbedModelSelectorComponent).handleInput('u');
    const filteredOutput = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
    expect(filteredOutput).toContain('Search: tu');
    expect(filteredOutput).toContain('Kimi Turbo');
    expect(filteredOutput).not.toContain('Kimi K2');
    // Turbo is a thinking-capable model that is not the active one, so it
    // defaults to thinking on — selecting it applies thinking without a toggle.
    (picker as TabbedModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('turbo');
      expect(session.setThinking).toHaveBeenCalledWith('on');
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('on');
  });

  it('applies /model selection to the session only on Alt+S without persisting', async () => {
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
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0];
    // /model turbo preselects turbo; Alt+S applies it to the current session only.
    (picker as TabbedModelSelectorComponent).handleInput(`${ESC}s`);

    await vi.waitFor(() => {
      expect(session.setModel).toHaveBeenCalledWith('turbo');
      expect(session.setThinking).toHaveBeenCalledWith('on');
    });
    expect(setConfig).not.toHaveBeenCalled();
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('on');
  });

  it('uses the effective effort returned after a model-switch fallback', async () => {
    let switched = false;
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: switched ? 'turbo' : 'k2',
        thinkingEffort: switched ? 'mid' : 'ultra',
        permission: 'manual',
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
      setModel: vi.fn(async () => {
        switched = true;
      }),
    });
    const setConfig = vi.fn(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'ultra'],
            defaultEffort: 'ultra',
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'mid', 'high'],
            defaultEffort: 'mid',
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'ultra' },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true, effort: 'mid' },
      });
    });
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('mid');
    expect(renderTranscript(driver)).toContain('Switched to kimi-turbo with thinking mid.');
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
        thinking: { enabled: true },
      })),
      setConfig,
    });

    driver.handleUserInput('/model k2');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0];
    (picker as TabbedModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'k2',
        thinking: { enabled: false },
      });
    });
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
  });

  it('does not write config when re-confirming the current effort in the picker', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
    });
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
            supportEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
        },
        defaultModel: 'k2',
        // No persisted effort: re-confirming the shown level must not turn the
        // runtime default into a stored preference.
        thinking: { enabled: true },
      })),
      setConfig,
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as EffortSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(renderTranscript(driver)).toContain('Already using Kimi K2 with thinking high.');
    });
    expect(setConfig).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
  });

  it('persists only the model when a switch keeps the same effort', async () => {
    let switched = false;
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: switched ? 'turbo' : 'k2',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
      setModel: vi.fn(async () => {
        switched = true;
      }),
    });
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
            supportEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Turbo',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'high' },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    // The effort matches the value shown when the picker opened, so the patch
    // carries no effort key; the stored preference stays as-is via the merge.
    await vi.waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });
  });

  it('refreshes only OAuth provider models before opening /model picker', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Old Kimi K2',
            capabilities: ['thinking'],
          },
        },
      })),
    });
    const tui = driver as unknown as KimiTUI;
    const refreshProviderModels = vi
      .spyOn(tui.authFlow, 'refreshProviderModels')
      .mockRejectedValue(new Error('full provider refresh should not run'));
    const refreshOAuthProviderModels = vi.fn(async () => {
      await Promise.resolve();
      tui.setAppState({
        availableModels: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Fresh Kimi K2',
            capabilities: ['thinking'],
          },
        },
      });
      return { changed: [], unchanged: ['managed:kimi-code'], failed: [] };
    });
    (
      tui.authFlow as unknown as {
        refreshOAuthProviderModels: typeof refreshOAuthProviderModels;
      }
    ).refreshOAuthProviderModels = refreshOAuthProviderModels;

    driver.handleUserInput('/model');

    await vi.waitFor(() => {
      const picker = driver.state.editorContainer.children[0];
      expect(picker).toBeInstanceOf(TabbedModelSelectorComponent);
      const output = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
      expect(output).toContain('Fresh Kimi K2');
      expect(output).not.toContain('Old Kimi K2');
    });
    expect(refreshOAuthProviderModels).toHaveBeenCalledOnce();
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('opens /model picker after 2s when OAuth refresh is still pending', async () => {
    const { driver } = await makeDriver(makeSession(), {
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
      })),
    });
    const tui = driver as unknown as KimiTUI;
    const refreshOAuthProviderModels = vi.fn(() => new Promise<never>(() => {}));
    (
      tui.authFlow as unknown as {
        refreshOAuthProviderModels: typeof refreshOAuthProviderModels;
      }
    ).refreshOAuthProviderModels = refreshOAuthProviderModels;

    vi.useFakeTimers();
    try {
      driver.handleUserInput('/model');
      await Promise.resolve();

      expect(refreshOAuthProviderModels).toHaveBeenCalledOnce();
      expect(driver.state.editorContainer.children[0]).not.toBeInstanceOf(TabbedModelSelectorComponent);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(driver.state.editorContainer.children[0]).not.toBeInstanceOf(TabbedModelSelectorComponent);

      await vi.advanceTimersByTimeAsync(1);
      const picker = driver.state.editorContainer.children[0];
      expect(picker).toBeInstanceOf(TabbedModelSelectorComponent);
      const output = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
      expect(output).toContain('Kimi K2');
    } finally {
      vi.useRealTimers();
    }
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
    expect(output).toContain('Kimi Turbo');
    expect(output).not.toContain('Kimi Alpha');

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

  it('updates terminal title through pi-tui without changing process title', async () => {
    const originalTitle = process.title;
    const { driver } = await makeDriver(makeSession({ id: 'ses-1' }));
    const setTitle = vi.spyOn(driver.state.terminal, 'setTitle').mockImplementation(() => {});

    try {
      process.title = 'kimi-test-runner';
      driver.sessionEventHandler.handleEvent(
        {
          type: 'session.meta.updated',
          sessionId: 'ses-1',
          agentId: 'main',
          title: 'Implement terminal title',
        } as Event,
        () => {},
      );

      expect(setTitle).toHaveBeenCalledWith('Implement terminal title');
      expect(process.title).toBe('kimi-test-runner');
    } finally {
      process.title = originalTitle;
    }
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
    const setTitle = vi.spyOn(driver.state.terminal, 'setTitle').mockImplementation(() => {});

    try {
      process.title = 'kimi-test-runner';
      driver.handleUserInput('/fork ignored args');

      await vi.waitFor(() => {
        expect(forkSession).toHaveBeenCalledWith({
          id: 'ses-source',
          title: 'Fork: Source title',
        });
        expect(driver.getCurrentSessionId()).toBe('ses-fork');
      });
      expect(setTitle).toHaveBeenCalledWith('Fork: Source title');
      expect(process.title).toBe('kimi-test-runner');
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

  it('does not create a thinking component for whitespace-only thinking deltas', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: ' ',
      } as Event,
      vi.fn(),
    );
    driver.streamingUI.flushNow();

    // Nothing to render: no component, and the phase is not hijacked into thinking.
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
    expect(driver.state.appState.streamingPhase).toBe('waiting');

    // Real thinking text after the whitespace still starts thinking normally.
    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'actual reasoning',
      } as Event,
      vi.fn(),
    );
    driver.streamingUI.flushNow();

    expect(driver.state.appState.streamingPhase).toBe('thinking');
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(true);
    expect(stripSgr(renderTranscript(driver))).toContain('actual reasoning');
  });

  it('does not create a thinking component for whitespace-only thinking on session replay', async () => {
    const { driver } = await makeDriver();

    // Session replay flushes stored thinking verbatim through onThinkingUpdate
    // (see SessionReplayRenderer.flushAssistant), so a persisted whitespace-only
    // think part must not become a bare bullet line.
    driver.streamingUI.onThinkingUpdate(' ');
    driver.streamingUI.onThinkingEnd();

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
    expect(
      driver.state.transcriptContainer.children.filter(
        (child) => child instanceof ThinkingComponent,
      ),
    ).toHaveLength(0);

    // Real stored thinking still replays normally.
    driver.streamingUI.onThinkingUpdate('visible reasoning');
    driver.streamingUI.onThinkingEnd();

    expect(stripSgr(renderTranscript(driver))).toContain('visible reasoning');
  });

  it('keeps the waiting moon spinner while reasoning streams only empty (encrypted) thinking deltas', async () => {
    const { driver } = await makeDriver();

    // Turn begins -> waiting mode shows the moon spinner.
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
      } as Event,
      vi.fn(),
    );
    expect(driver.state.appState.streamingPhase).toBe('waiting');
    expect(driver.state.livePane.mode).toBe('waiting');

    // Encrypted reasoning: thinking.delta events whose visible text is empty.
    for (let i = 0; i < 3; i++) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'thinking.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          delta: '',
        } as Event,
        vi.fn(),
      );
    }

    // The moon must stay up: still waiting, no orphan thinking component, and
    // the activity pane still renders a moon frame (no blank, spinner-less gap).
    expect(driver.state.appState.streamingPhase).toBe('waiting');
    expect(driver.state.livePane.mode).toBe('waiting');
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
    const activity = stripSgr(renderActivity(driver));
    expect(MOON_SPINNER_FRAMES.some((frame) => activity.includes(frame))).toBe(true);

    // Real thinking text finally arrives -> transition into thinking mode.
    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'actual reasoning',
      } as Event,
      vi.fn(),
    );
    driver.streamingUI.flushNow();
    expect(driver.state.appState.streamingPhase).toBe('thinking');
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(true);
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
    expect(transcript).not.toContain('ctrl+o expand');
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

describe('/model status displayName override', () => {
  it('shows the overridden display name in the switch status', async () => {
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
            displayName: 'Remote Turbo',
            capabilities: ['thinking'],
            overrides: { displayName: 'Custom Turbo' },
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });

    expect(renderTranscript(driver)).toContain('Switched to Custom Turbo with thinking on.');
    expect(renderTranscript(driver)).not.toContain('Remote Turbo');
  });
});

describe('/effort support_efforts override', () => {
  it('warns and applies efforts hidden by an Anthropic support_efforts override', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            protocol: 'anthropic',
            maxContextSize: 100,
            displayName: 'Compatible Model',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            overrides: { supportEfforts: ['low', 'high'] },
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'low' },
      })),
    });

    driver.handleUserInput('/effort max');

    await vi.waitFor(() => {
      expect(session.setThinking).toHaveBeenCalledWith('max');
    });
    await vi.waitFor(() => {
      expect(renderTranscript(driver)).toContain('Thinking set to max.');
    });
    const transcript = renderTranscript(driver).replaceAll(/\s+/g, ' ');
    expect(transcript).toContain(
      'Thinking effort "max" is not listed for k2 (known: low, high). Sending "max" unchanged; the configured provider will validate it.',
    );
    expect(transcript).toContain('Thinking set to max.');
  });

  it('offers the latest Opus efforts for an unknown Anthropic-compatible model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'anthropic', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).toContain('Max');
  });

  it('offers no fallback efforts for an unknown model on a Kimi provider using the Anthropic protocol', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            protocol: 'anthropic',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).not.toContain('Max');
  });

  it('offers the latest Opus efforts for a flat providerless Anthropic model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {},
        models: {
          // v2 flat model shape: no named provider, inline endpoint + protocol.
          k2: {
            model: 'compatible-model',
            baseUrl: 'https://anthropic.example.test',
            protocol: 'anthropic',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).toContain('Max');
  });

  it('keeps rejecting efforts hidden by a Kimi support_efforts override', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        providers: {
          kimi: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'kimi',
            model: 'kimi-model',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'low' },
      })),
    });

    driver.handleUserInput('/effort max');

    await vi.waitFor(() => {
      expect(renderTranscript(driver)).toContain(
        'Unsupported thinking effort "max" for k2. Available: off, low, high',
      );
    });
    expect(session.setThinking).not.toHaveBeenCalled();
  });
});
