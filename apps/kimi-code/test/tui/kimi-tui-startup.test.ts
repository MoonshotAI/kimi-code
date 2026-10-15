import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log, type GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { BannerProvider } from '#/tui/banner/banner-provider';
import { readBannerDisplayState } from '#/tui/banner/state';
import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import { promptPlatformSelection, promptLogoutProviderSelection } from '#/tui/commands/prompts';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { BannerComponent } from '#/tui/components/chrome/banner';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import { maybeShowModelMigrationPrompt } from '#/tui/controllers/model-migration';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import { REPLAY_FETCH_TURN_LIMIT } from '#/tui/utils/message-replay';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { quoteShellArg } from '#/utils/shell-quote';
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_LIGHT,
} from '#/tui/utils/terminal-theme';

vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return { ...actual, promptPlatformSelection: vi.fn(), promptLogoutProviderSelection: vi.fn() };
});
vi.mock('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));
const modelMigrationState = vi.hoisted(() => ({ acknowledged: {} as Record<string, string> }));
vi.mock('#/utils/model-migration-state', () => ({
  readModelMigrationAcknowledgements: vi.fn(async () => ({ ...modelMigrationState.acknowledged })),
  acknowledgeModelMigration: vi.fn(async (fromAlias: string, toModel: string) => {
    modelMigrationState.acknowledged = { ...modelMigrationState.acknowledged, [fromAlias]: toModel };
  }),
}));

const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

interface StartupDriver {
  state: TUIState;
  init(): Promise<boolean>;
  handleLoginCommand(): Promise<void>;
  handleLogoutCommand(): Promise<void>;
  stop(exitCode?: number): Promise<void>;
  setSession(session: unknown): Promise<void>;
  syncRuntimeState(session?: unknown): Promise<void>;
}

interface RuntimeStateDriver extends StartupDriver {
  closeSession(reason: string): Promise<void>;
}

interface ThemeTrackingDriver extends StartupDriver {
  refreshTerminalThemeTracking(): void;
}

interface MigrateExitDriver extends StartupDriver {
  start(): Promise<void>;
  onExit?: (code?: number) => Promise<void>;
  runMigrationScreen(plan: unknown): Promise<unknown>;
  initMainTui(): Promise<boolean>;
  terminalFocusTrackingDispose?: () => void;
}

const MIGRATION_PLAN: MigrationPlan = {
  sourceHome: '/x/.kimi',
  hasConfig: false,
  hasMcp: false,
  hasUserHistory: false,
  hasSkills: false,
  hasPlans: false,
  oauthCredentials: [],
  workdirs: [],
  detectedPlugins: [],
  detectedMcpOauthServers: [],
  totalSessions: 0,
};

function makeStartupInput(
  cliOptions: Partial<KimiTUIStartupInput['cliOptions']> = {},
  tuiConfig: Partial<KimiTUIStartupInput['tuiConfig']> = {},
): KimiTUIStartupInput {
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
      ...cliOptions,
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
      ...tuiConfig,
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: 'Session title' },
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    getGoal: vi.fn(async () => ({ goal: null })),
    onEvent: vi.fn(() => () => {}),
    getResumeState: vi.fn(() => null),
    listSkills: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective: 'Ship feature X',
    status: 'paused',
    turnsUsed: 2,
    tokensUsed: 100,
    wallClockMs: 1000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    ...overrides,
  };
}

function createResumeState(overrides: { permissionMode?: string; planMode?: boolean } = {}) {
  return {
    id: 'ses-latest',
    workDir: '/tmp/proj-a',
    sessionDir: '/tmp/proj-a/.kimi/sessions/ses-latest',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionMetadata: {},
    agents: {
      main: {
        type: 'main',
        config: {
          cwd: '/tmp/proj-a',
          modelCapabilities: { max_context_tokens: 100 },
          thinkingEffort: 'off',
          systemPrompt: '',
        },
        context: { history: [], tokenCount: 10 },
        replay: [],
        permission: { mode: overrides.permissionMode ?? 'manual', rules: [] },
        plan: overrides.planMode ? { id: 'plan-1', content: '', path: '/tmp/plan.md' } : null,
        swarmMode: false,
        usage: {},
        tools: [],
        background: [],
      },
    },
  } as never;
}

function loginRequiredError(): Error & { readonly code: string } {
  return Object.assign(new Error('OAuth provider "managed:kimi-code" requires login.'), {
    code: 'auth.login_required',
  });
}

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  const harness = {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 100 },
      },
    })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    getWorkspaceTrustInfo: vi.fn(async () => ({ trusted: true, gatedMcpServers: [], gatedAdditionalDirs: [], additionalDirSources: [], warnings: [], instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] } })),
    refreshProviderModels: vi.fn(async () => ({ changed: [], unchanged: [], failed: [] })),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      getCachedAccessToken: vi.fn(async () => undefined),
    },
    ...overrides,
  };
  if (!('listSessionsPage' in harness)) {
    const listSessions = harness.listSessions as (input?: {
      workDir?: string;
      sessionId?: string;
    }) => Promise<unknown[]>;
    Object.assign(harness, {
      listSessionsPage: vi.fn(
        async (input: { workDir?: string; sessionId?: string } = {}) => ({
          items: await listSessions({ workDir: input.workDir, sessionId: input.sessionId }),
          nextCursor: undefined,
        }),
      ),
    });
  }
  return harness;
}

function makeDriver(harness: ReturnType<typeof makeHarness>, input: KimiTUIStartupInput) {
  const driver = new KimiTUI(harness as never, input) as unknown as StartupDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  return driver;
}

type InputListener = Parameters<TUIState['ui']['addInputListener']>[0];
const DARK_OSC11_REPORT = '\u001B]11;rgb:2828/2c2c/3434\u0007';
const LIGHT_OSC11_REPORT = '\u001B]11;rgb:fafa/fbfb/fcfc\u0007';

function captureInputListeners(driver: StartupDriver) {
  const listeners: InputListener[] = [];
  const removeInputListener = vi.fn<() => void>();
  const write = vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
  const addInputListener = vi
    .spyOn(driver.state.ui, 'addInputListener')
    .mockImplementation((listener: InputListener) => {
      listeners.push(listener);
      return removeInputListener;
    });

  return { listeners, removeInputListener, write, addInputListener };
}

describe('KimiTUI startup', () => {
  it('starts session-less on the v2 engine and carries startup flags to appState', async () => {
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 200 },
        },
        defaultModel: 'k2',
        defaultPermissionMode: 'auto',
      })),
    });
    const driver = makeDriver(
      harness,
      { ...makeStartupInput({ model: 'k2', yolo: true }) },
    );

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: 'k2',
      permissionMode: 'yolo',
    });
  });

  it('mounts the docked fullscreen layout when tui_mode is fullscreen', async () => {
    const harness = makeHarness(makeSession());
    const driver = makeDriver(harness, { ...makeStartupInput({}, { tuiMode: 'fullscreen' }) });

    expect(driver.state.ui.mode).toBe('fullscreen');
    expect(driver.state.ui.children).toHaveLength(0);

    await expect(driver.init()).resolves.toBe(false);
    (driver as unknown as { mountFooter(): void }).mountFooter();

    // Dock = 7 chrome containers + footer wrap, below the transcript viewport.
    expect(driver.state.dockContainer?.children).toHaveLength(8);
  });

  it('shows a session-less notice on v2 startup', async () => {
    const harness = makeHarness(makeSession());
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);
    await (
      driver as unknown as { finishStartup(shouldReplayHistory: boolean): Promise<void> }
    ).finishStartup(false);

    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('No session yet — one will be created on your first message.');
  });

  it('shows config defaults in appState before the lazy session exists (v2)', async () => {
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 200 },
        },
        defaultModel: 'k2',
        defaultPermissionMode: 'auto',
        defaultPlanMode: true,
        thinking: { enabled: true, effort: 'high' },
      })),
    });
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: 'k2',
      maxContextTokens: 200,
      permissionMode: 'auto',
      planMode: true,
      thinkingEffort: 'high',
    });
  });

  it('hydrates the model default effort when thinking is enabled without an effort (v2)', async () => {
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            model: 'moonshot-v1',
            maxContextSize: 200,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true },
      })),
    });
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState.thinkingEffort).toBe('high');
  });

  it('hydrates the model default effort when no [thinking] section exists (v2)', async () => {
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            model: 'moonshot-v1',
            maxContextSize: 200,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'medium', 'high'],
          },
        },
        defaultModel: 'k2',
      })),
    });
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.appState.thinkingEffort).toBe('medium');
  });

  it('hydrates permission/plan defaults after a session-less v2 login', async () => {
    let loggedIn = false;
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () =>
        loggedIn
          ? {
              models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
              defaultModel: 'k2',
              defaultPermissionMode: 'auto',
              defaultPlanMode: true,
            }
          : { models: {} },
      ),
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async () => {
          loggedIn = true;
        }),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      permissionMode: 'manual',
      planMode: false,
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: 'k2',
      permissionMode: 'auto',
      planMode: true,
      configDefaultPlanMode: true,
    });
  });

  it('hydrates permission defaults after a session-less v2 login without a default model', async () => {
    let loggedIn = false;
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () =>
        loggedIn
          ? {
              models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
              defaultPermissionMode: 'auto',
            }
          : { models: {} },
      ),
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async () => {
          loggedIn = true;
        }),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      permissionMode: 'auto',
    });
  });

  it('carries the --agent/--agent-file binding for the lazy-created first session (v2)', async () => {
    const harness = makeHarness(makeSession());
    const driver = makeDriver(
      harness,
      {
        ...makeStartupInput({ model: 'k2', agentFiles: ['agent.md'] }),
        agentProfile: 'reviewer',
      },
    );

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      agentProfile: 'reviewer',
      agentFiles: ['agent.md'],
    });
  });

  it('resumes the latest session for --continue and marks history for replay', async () => {
    const session = makeSession({ id: 'ses-latest' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }, { id: 'ses-old' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-latest',
      replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('ses-latest');
  });

  it('applies --auto permission when resuming a session via --continue', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, auto: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('applies --yolo permission when resuming a session via --continue', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, yolo: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(driver.state.appState.permissionMode).toBe('yolo');
  });

  it('applies --plan mode when resuming a session via --continue', async () => {
    let planMode = false;
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async (enabled: boolean) => {
        planMode = enabled;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('skips setPlanMode when the resumed session is already in plan mode', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('forces footer state to reflect --auto even if getStatus lags behind', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async () => {}),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, auto: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('forces footer state to reflect --plan even if getStatus lags behind', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {}),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('keeps --auto in the footer after session replay hydration', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getResumeState: vi.fn(() => createResumeState({ permissionMode: 'manual', planMode: false })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, auto: true }));

    await expect(driver.init()).resolves.toBe(true);
    await (
      driver as unknown as {
        finishStartup(shouldReplayHistory: boolean): Promise<void>;
      }
    ).finishStartup(true);

    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('keeps --plan in the footer after session replay hydration', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getResumeState: vi.fn(() => createResumeState({ permissionMode: 'manual', planMode: false })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);
    await (
      driver as unknown as {
        finishStartup(shouldReplayHistory: boolean): Promise<void>;
      }
    ).finishStartup(true);

    expect(driver.state.appState.planMode).toBe(true);
  });

  it('applies --auto permission when resuming an explicit session', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-target',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: 'ses-target', auto: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('syncs a persisted goal when resuming a session', async () => {
    const goal = goalSnapshot({ status: 'blocked', terminalReason: 'needs input' });
    const session = makeSession({
      id: 'ses-latest',
      getGoal: vi.fn(async () => ({ goal })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
      getExperimentalFeatures: vi.fn(async () => [{ id: 'micro_compaction', enabled: true }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(driver.state.appState.goal).toEqual(goal);
  });

  it('syncs goal state regardless of the goal flag', async () => {
    const goal = goalSnapshot();
    const session = makeSession({
      getGoal: vi.fn(async () => ({ goal })),
    });
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    await driver.setSession(session);
    await driver.syncRuntimeState(session);

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(driver.state.appState.goal).toEqual(goal);
  });

  it('clears goal state when closing the current session', async () => {
    const goal = goalSnapshot();
    const session = makeSession({
      getGoal: vi.fn(async () => ({ goal })),
    });
    const harness = makeHarness(session, {
      getExperimentalFeatures: vi.fn(async () => [{ id: 'micro_compaction', enabled: true }]),
    });
    const driver = makeDriver(harness, makeStartupInput()) as unknown as RuntimeStateDriver;

    await expect(driver.init()).resolves.toBe(false);
    await driver.setSession(session);
    await driver.syncRuntimeState(session);
    expect(driver.state.appState.goal).toEqual(goal);

    await driver.closeSession('test close');

    expect(driver.state.appState.goal).toBeNull();
  });

  it('applies the CLI model override when resuming a startup session', async () => {
    let model = 'k2';
    const session = makeSession({
      setModel: vi.fn(async (nextModel: string) => {
        model = nextModel;
      }),
      getStatus: vi.fn(async () => ({
        model,
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ continue: true, model: 'kimi-code/k2.5' }),
    );

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setModel).toHaveBeenCalledWith('kimi-code/k2.5');
    expect(driver.state.appState.model).toBe('kimi-code/k2.5');
  });

  it('enters picker startup for bare --session without creating a session', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('picker');
  });

  it('applies --auto after picking a session from bare --session', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-picked',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [
        {
          id: 'ses-picked',
          title: 'Picked session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '', auto: true }));

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    expect(driver.state.startupState).toBe('picker');
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('skips setPlanMode after picking a session already in plan mode', async () => {
    const session = makeSession({
      id: 'ses-picked',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [
        {
          id: 'ses-picked',
          title: 'Picked session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '', plan: true }));

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    expect(driver.state.startupState).toBe('picker');
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('toggles the sessions picker from current cwd to all sessions with Ctrl+A', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    expect(listSessions).toHaveBeenNthCalledWith(1, { workDir: '/tmp/proj-a' });
    expect(listSessions).toHaveBeenNthCalledWith(2, {});
    expect(driver.state.sessionsScope).toBe('all');
    expect(driver.state.sessions.map((session) => session.id)).toEqual([
      'ses-cwd',
      'ses-other-cwd',
    ]);
  });

  it('toggles the sessions picker from all sessions back to current cwd with Ctrl+A', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const firstPicker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    firstPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));
    const allPicker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    allPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    expect(listSessions).toHaveBeenNthCalledWith(3, { workDir: '/tmp/proj-a' });
    expect(driver.state.sessionsScope).toBe('cwd');
    expect(driver.state.sessions.map((session) => session.id)).toEqual(['ses-cwd']);
  });

  it('does not remount the session picker after it is closed while a scope toggle is pending', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    let resolveAllSessions: ((value: unknown[]) => void) | undefined;
    const listSessions = vi.fn((input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return Promise.resolve([currentWorkDirSession]);
      return new Promise<unknown[]>((resolve) => {
        resolveAllSessions = resolve;
      });
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    const mountSessionPicker = vi.spyOn(
      driver as unknown as { mountSessionPicker(options: unknown): void },
      'mountSessionPicker',
    );
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0001');
    (driver as unknown as { hideSessionPicker(): void }).hideSessionPicker();
    resolveAllSessions?.([currentWorkDirSession, otherWorkDirSession]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(driver.state.activeDialog).toBeNull();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);
  });

  function makePagedListSessionsPage() {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `ses-page1-${String(index).padStart(2, '0')}`,
      workDir: '/tmp/proj-a',
      updatedAt: Date.now() - index * 1000,
    }));
    return vi.fn(async (input: { workDir?: string; before?: string } = {}) =>
      input.before === undefined
        ? { items: firstPage, nextCursor: 'ses-page1-49' }
        : {
            items: [{ id: 'ses-page2-0', workDir: '/tmp/proj-a', updatedAt: 0 }],
            nextCursor: undefined,
          },
    );
  }

  it('fetches the next session page when the picker scrolls to the fetched end', async () => {
    const listSessionsPage = makePagedListSessionsPage();
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessionsPage });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(listSessionsPage).toHaveBeenCalledWith({ workDir: '/tmp/proj-a', limit: 50 });
    expect(driver.state.sessions).toHaveLength(50);

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    for (let i = 0; i < 49; i++) {
      picker.handleInput('\u001B[B');
    }
    await vi.waitFor(() => {
      expect(driver.state.sessions).toHaveLength(51);
    });

    expect(listSessionsPage).toHaveBeenLastCalledWith({
      workDir: '/tmp/proj-a',
      limit: 50,
      before: 'ses-page1-49',
    });
    expect(driver.state.sessions.map((session) => session.id)).toContain('ses-page2-0');
  });

  it('drains the remaining session pages in the background once a query is typed', async () => {
    const listSessionsPage = makePagedListSessionsPage();
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessionsPage });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(driver.state.sessions).toHaveLength(50);

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('x');
    await vi.waitFor(() => {
      expect(driver.state.sessions).toHaveLength(51);
    });

    expect(listSessionsPage).toHaveBeenLastCalledWith({
      workDir: '/tmp/proj-a',
      limit: 50,
      before: 'ses-page1-49',
    });
  });

  it('continues the search drain after an in-flight scroll fetch settles', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `ses-page1-${String(index).padStart(2, '0')}`,
      workDir: '/tmp/proj-a',
      updatedAt: Date.now() - index * 1000,
    }));
    let resolveScrollPage!: (page: { items: unknown[]; nextCursor?: string }) => void;
    const listSessionsPage = vi.fn((input: { workDir?: string; before?: string } = {}) => {
      if (input.before === undefined) {
        return Promise.resolve({ items: firstPage, nextCursor: 'ses-page1-49' });
      }
      if (input.before === 'ses-page1-49') {
        return new Promise<{ items: unknown[]; nextCursor?: string }>((resolve) => {
          resolveScrollPage = resolve;
        });
      }
      return Promise.resolve({
        items: [{ id: 'ses-page3-0', workDir: '/tmp/proj-a', updatedAt: 0 }],
        nextCursor: undefined,
      });
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessionsPage });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    for (let i = 0; i < 49; i++) {
      picker.handleInput('\u001B[B');
    }
    await vi.waitFor(() => {
      expect(listSessionsPage).toHaveBeenCalledWith({
        workDir: '/tmp/proj-a',
        limit: 50,
        before: 'ses-page1-49',
      });
    });

    picker.handleInput('x');
    resolveScrollPage({
      items: [{ id: 'ses-page2-0', workDir: '/tmp/proj-a', updatedAt: 1 }],
      nextCursor: 'ses-page2-0',
    });
    await vi.waitFor(() => {
      expect(driver.state.sessions).toHaveLength(52);
    });
    expect(listSessionsPage).toHaveBeenLastCalledWith({
      workDir: '/tmp/proj-a',
      limit: 50,
      before: 'ses-page2-0',
    });
  });

  it('clears the sessions picker search query when toggling scope with Ctrl+A', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const firstPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    firstPicker.handleInput('c');
    firstPicker.handleInput('w');
    firstPicker.handleInput('d');
    expect(firstPicker.render(160).join('\n')).toContain('Search: cwd');

    firstPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    const allPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const output = allPicker.render(160).join('\n');

    expect(driver.state.sessionsScope).toBe('all');
    expect(output).toContain('All sessions');
    expect(output).toContain('(type to search)');
    expect(output).not.toContain('Search: cwd');
  });

  it('deletes a session from the picker and refreshes the list', async () => {
    const sesA = { id: 'ses-a', title: 'Session A', workDir: '/tmp/proj-a', updatedAt: Date.now() };
    const sesB = {
      id: 'ses-b',
      title: 'Session B',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now() - 1000,
    };
    let deleted = false;
    const listSessions = vi.fn(async () => (deleted ? [sesB] : [sesA, sesB]));
    const deleteSession = vi.fn(async () => {
      deleted = true;
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions, deleteSession });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    picker.handleInput('\u0018');
    expect(picker.render(160).join('\n')).toContain('Delete session "Session A"? [y/N]');
    picker.handleInput('y');

    await vi.waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('ses-a');
    });
    await vi.waitFor(() => {
      const remounted = driver.state.editorContainer.children[0] as {
        render(width: number): string[];
      };
      expect(remounted.render(160).join('\n')).not.toContain('Session A');
    });
    expect(driver.state.activeDialog).toBe('session-picker');
  });

  it('deleting the current session closes it, deletes it, and starts a new session', async () => {
    const session = makeSession({ id: 'ses-current' });
    const sesCurrent = {
      id: 'ses-current',
      title: 'Current session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    let resolveDelete!: () => void;
    const deleteSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [sesCurrent]),
      deleteSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();
    expect(driver.state.appState.sessionId).toBe('ses-current');
    // Contentless current sessions are filtered out of picker rows; fake content so the row exists.
    vi.spyOn(driver as unknown as { hasSessionContent(): boolean }, 'hasSessionContent')
      .mockReturnValue(true);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    // The picker (and its input lock) stays mounted until the replacement
    // session is ready; the editor must not accept input mid-flight.
    await vi.waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('ses-current');
    });
    expect(driver.state.activeDialog).toBe('session-picker');
    resolveDelete();

    await vi.waitFor(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(2);
    });
    expect(session.close).toHaveBeenCalled();
    expect(driver.state.activeDialog).toBeNull();
  });

  it('reattaches to the current session when deleting it fails', async () => {
    const session = makeSession({ id: 'ses-current' });
    const sesCurrent = {
      id: 'ses-current',
      title: 'Current session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const deleteSession = vi.fn(async () => {
      throw new Error('boom');
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [sesCurrent]),
      deleteSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();
    vi.spyOn(driver as unknown as { hasSessionContent(): boolean }, 'hasSessionContent')
      .mockReturnValue(true);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      expect(harness.resumeSession).toHaveBeenCalledWith({
        id: 'ses-current',
        replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
      });
    });
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-current');
    });
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('Failed to delete session ses-current');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('reattaches when closing the current session fails during deletion', async () => {
    const session = makeSession({
      id: 'ses-current',
      close: vi.fn(async () => {
        throw new Error('close boom');
      }),
    });
    const sesCurrent = {
      id: 'ses-current',
      title: 'Current session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const deleteSession = vi.fn(async () => {});
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [sesCurrent]),
      deleteSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();
    vi.spyOn(driver as unknown as { hasSessionContent(): boolean }, 'hasSessionContent')
      .mockReturnValue(true);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      expect(harness.resumeSession).toHaveBeenCalledWith({
        id: 'ses-current',
        replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
      });
    });
    expect(deleteSession).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-current');
    });
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('Failed to delete session ses-current');
  });

  it('drops the deleted row locally when the post-delete list refresh fails', async () => {
    const sesA = { id: 'ses-a', title: 'Session A', workDir: '/tmp/proj-a', updatedAt: Date.now() };
    const sesB = {
      id: 'ses-b',
      title: 'Session B',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now() - 1000,
    };
    let refreshCalls = 0;
    const listSessions = vi.fn(async () => {
      refreshCalls += 1;
      if (refreshCalls > 1) throw new Error('refresh boom');
      return [sesA, sesB];
    });
    const deleteSession = vi.fn(async () => {});
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions, deleteSession });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('ses-a');
    });
    await vi.waitFor(() => {
      const remounted = driver.state.editorContainer.children[0] as {
        render(width: number): string[];
      };
      const output = remounted.render(160).join('\n');
      expect(output).not.toContain('Session A');
      expect(output).toContain('Session B');
    });
    expect(driver.state.activeDialog).toBe('session-picker');
  });

  it('keeps the picker open and surfaces an error when deletion fails', async () => {
    const sesA = { id: 'ses-a', title: 'Session A', workDir: '/tmp/proj-a', updatedAt: Date.now() };
    const deleteSession = vi.fn(async () => {
      throw new Error('boom');
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      listSessions: vi.fn(async () => [sesA]),
      deleteSession,
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      const transcript = driver.state.transcriptContainer.render(160).join('\n');
      expect(transcript).toContain('Failed to delete session ses-a');
    });
    expect(driver.state.activeDialog).toBe('session-picker');
  });

  it('does not arm deletion while a picker selection is in flight', async () => {
    const picked = makeSession({ id: 'ses-2' });
    let resolveResume!: (session: unknown) => void;
    const resumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    const deleteSession = vi.fn(async () => {});
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      deleteSession,
      listSessions: vi.fn(async () => [
        { id: 'ses-2', title: 'Other session', workDir: '/tmp/proj-a', updatedAt: Date.now() },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    picker.handleInput('\r');
    await vi.waitFor(() => {
      expect(resumeSession).toHaveBeenCalled();
    });

    picker.handleInput('\u0018');
    expect(picker.render(160).join('\n')).not.toContain('Delete session');
    expect(deleteSession).not.toHaveBeenCalled();

    resolveResume(picked);
    await vi.waitFor(() => {
      expect(driver.state.activeDialog).toBeNull();
    });
  });

  it('does not remount the picker while a deletion is in flight and a scope toggle is pending', async () => {
    const sesA = { id: 'ses-a', title: 'Session A', workDir: '/tmp/proj-a', updatedAt: Date.now() };
    const sesB = {
      id: 'ses-b',
      title: 'Session B',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now() - 1000,
    };
    let resolveAllSessions: ((value: unknown[]) => void) | undefined;
    let resolveDelete: (() => void) | undefined;
    let allFetchPending = true;
    const listSessions = vi.fn((input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return Promise.resolve([sesA, sesB]);
      if (allFetchPending) {
        allFetchPending = false;
        return new Promise<unknown[]>((resolve) => {
          resolveAllSessions = resolve;
        });
      }
      return Promise.resolve([sesA, sesB]);
    });
    const deleteSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions, deleteSession });
    const driver = makeDriver(harness, makeStartupInput());
    const mountSessionPicker = vi.spyOn(
      driver as unknown as { mountSessionPicker(options: unknown): void },
      'mountSessionPicker',
    );
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0001');
    picker.handleInput('\u0018');
    picker.handleInput('y');
    await vi.waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('ses-a');
    });

    resolveAllSessions?.([sesA, sesB]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mountSessionPicker).toHaveBeenCalledTimes(1);
    expect(driver.state.editorContainer.children[0]).toBe(picker);

    resolveDelete?.();
    await vi.waitFor(() => {
      expect(mountSessionPicker).toHaveBeenCalledTimes(2);
    });
  });

  it('does not remount the picker while a selection is in flight and a scope toggle is pending', async () => {
    const picked = makeSession({ id: 'ses-2' });
    const ses2 = { id: 'ses-2', title: 'Other session', workDir: '/tmp/proj-a', updatedAt: Date.now() };
    let resolveAllSessions: ((value: unknown[]) => void) | undefined;
    let resolveResume: ((value: unknown) => void) | undefined;
    const listSessions = vi.fn((input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return Promise.resolve([ses2]);
      return new Promise<unknown[]>((resolve) => {
        resolveAllSessions = resolve;
      });
    });
    const resumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions, resumeSession });
    const driver = makeDriver(harness, makeStartupInput());
    const mountSessionPicker = vi.spyOn(
      driver as unknown as { mountSessionPicker(options: unknown): void },
      'mountSessionPicker',
    );
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0001');
    picker.handleInput('\r');
    await vi.waitFor(() => {
      expect(resumeSession).toHaveBeenCalled();
    });

    resolveAllSessions?.([ses2]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mountSessionPicker).toHaveBeenCalledTimes(1);
    expect(driver.state.editorContainer.children[0]).toBe(picker);

    resolveResume?.(picked);
    await vi.waitFor(() => {
      expect(driver.state.activeDialog).toBeNull();
    });
  });

  it('resets the detached UI when replacement creation fails after deleting the current session', async () => {
    const session = makeSession({ id: 'ses-current' });
    const sesCurrent = {
      id: 'ses-current',
      title: 'Current session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const deleteSession = vi.fn(async () => {});
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [sesCurrent]),
      deleteSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();
    expect(driver.state.appState.sessionId).toBe('ses-current');
    // Contentless current sessions are filtered out of picker rows; fake content so the row exists.
    vi.spyOn(driver as unknown as { hasSessionContent(): boolean }, 'hasSessionContent')
      .mockReturnValue(true);
    harness.createSession.mockRejectedValueOnce(new Error('create boom'));

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      const transcript = driver.state.transcriptContainer.render(160).join('\n');
      expect(transcript).toContain('Failed to start a new session');
    });
    expect(driver.state.appState.sessionId).toBe('');
    expect(driver.state.activeDialog).toBeNull();
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).not.toContain('Started a new session (ses-current)');
  });

  it('resets the detached UI when recovery creation also fails after a failed delete', async () => {
    const session = makeSession({ id: 'ses-current' });
    const sesCurrent = {
      id: 'ses-current',
      title: 'Current session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const deleteSession = vi.fn(async () => {
      throw new Error('delete boom');
    });
    const resumeSession = vi.fn(async () => {
      throw new Error('resume boom');
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [sesCurrent]),
      deleteSession,
      resumeSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();
    expect(driver.state.appState.sessionId).toBe('ses-current');
    // Contentless current sessions are filtered out of picker rows; fake content so the row exists.
    vi.spyOn(driver as unknown as { hasSessionContent(): boolean }, 'hasSessionContent')
      .mockReturnValue(true);
    harness.createSession.mockRejectedValueOnce(new Error('create boom'));

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      const transcript = driver.state.transcriptContainer.render(160).join('\n');
      expect(transcript).toContain('Failed to delete session ses-current');
    });
    expect(driver.state.appState.sessionId).toBe('');
    expect(driver.state.activeDialog).toBeNull();
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).not.toContain('Started a new session (ses-current)');
  });

  it('does not resume a session from a different cwd and shows a cd hint', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-other-cwd' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      listSessions: vi.fn(async () => [currentWorkDirSession, otherWorkDirSession]),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);
    copyTextToClipboardMock.mockClear();

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    expect(driver.state.activeDialog).toBeNull();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj-b')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('Current session is in a different working directory.');
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
    expect(transcript).toContain('Command copied to clipboard');
  });

  it('copies a shell-safe resume command for another cwd with metacharacters', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj$(touch /tmp/pwned)',
      updatedAt: Date.now() - 1000,
    };
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-other-cwd' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      listSessions: vi.fn(async () => [currentWorkDirSession, otherWorkDirSession]),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);
    copyTextToClipboardMock.mockClear();

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj$(touch /tmp/pwned)')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
  });

  it('exits after picking another cwd from the startup picker', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-other-cwd' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      listSessions: vi.fn(async () => [currentWorkDirSession, otherWorkDirSession]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));
    const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
    copyTextToClipboardMock.mockClear();

    await expect((driver as unknown as MigrateExitDriver).initMainTui()).resolves.toBe(false);
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj-b')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(0);
  });

  it('does not apply startup flags when switching sessions via the /sessions picker', async () => {
    const initial = makeSession({ id: 'ses-1' });
    const picked = makeSession({
      id: 'ses-2',
      setPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const harness = makeHarness(initial, {
      resumeSession: vi.fn(async () => picked),
      listSessions: vi.fn(async () => [
        {
          id: 'ses-2',
          title: 'Other session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ auto: true, plan: true }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(driver.state.appState.sessionId).toBe('ses-2');
    expect(picked.setPermission).not.toHaveBeenCalled();
    expect(picked.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.permissionMode).toBe('manual');
    expect(driver.state.appState.planMode).toBe(false);
  });

  it('clears startup picker exit confirmation before resuming a selected session', async () => {
    const session = makeSession({ id: 'ses-picked' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [
        {
          id: 'ses-picked',
          title: 'Picked session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));
    const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);

    await expect((driver as unknown as MigrateExitDriver).initMainTui()).resolves.toBe(false);
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0003');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    driver.state.editor.onCtrlC?.();

    expect(stop).not.toHaveBeenCalled();
  });

  it('tracks terminal theme reports while auto theme is active', () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: 'auto' }),
    ) as unknown as ThemeTrackingDriver;
    const { listeners, write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    write.mockClear();
    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(DARK_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).toHaveBeenCalled();
  });

  it('does not track terminal theme reports for explicit themes', () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput()) as unknown as ThemeTrackingDriver;
    const { write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('disables terminal theme reports after leaving auto theme', () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: 'auto' }),
    ) as unknown as ThemeTrackingDriver;
    const { write, removeInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();
    driver.state.appState.theme = 'dark';
    driver.refreshTerminalThemeTracking();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });

  it("only shows provider refresh status for added models", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput());
    const showStatus = vi.spyOn(driver as any, "showStatus").mockImplementation(() => {});
    vi.spyOn((driver as any).authFlow, "refreshProviderModels").mockResolvedValue({
      changed: [
        { provider_id: "new-models", provider_name: "New Models", added: 2, removed: 0 },
        { provider_id: "removed-models", provider_name: "Removed Models", added: 0, removed: 3 },
        { provider_id: "metadata-only", provider_name: "Metadata Only", added: 0, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });

    await (driver as any).refreshProviderModelsInBackground();

    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledWith("New Models · +2 models.");
  });

  async function flushMigrationCheck(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function installMigrationModels(driver: StartupDriver): void {
    modelMigrationState.acknowledged = {};
    driver.state.appState.model = 'acme/current';
    driver.state.appState.thinkingEffort = 'off';
    driver.state.appState.availableProviders = {
      acme: { type: 'openai' },
    };
    driver.state.appState.availableModels = {
      'acme/current': {
        provider: 'acme',
        model: 'current',
        maxContextSize: 100,
        capabilities: ['tool_use'],
        upgrade: {
          model: 'acme/next',
          migrationMarkdown: 'Use current to next',
          retirementAt: undefined,
        },
      },
      'acme/next': {
        provider: 'acme',
        model: 'next',
        maxContextSize: 100,
        capabilities: ['tool_use', 'thinking'],
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    };
  }

  it.each(['off', 'high'])('persists the migration default effort when the live effort is %s', async (liveEffort) => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'acme/next',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const setConfig = vi.fn(async () => ({}));
    const harness = makeHarness(session, {
      setConfig,
      getConfig: vi.fn(async () => ({
        defaultModel: 'acme/current',
        thinking: { enabled: true, effort: 'low' },
      })),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await driver.setSession(session);
    installMigrationModels(driver);
    driver.state.appState.thinkingEffort = liveEffort;

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    expect(picker.render(100).join('\n')).toContain('Use current to next');
    picker.handleInput('\r');
    await prompt;

    expect(session.setModel).toHaveBeenCalledWith('acme/next');
    if (liveEffort === 'high') {
      expect(session.setThinking).not.toHaveBeenCalled();
    } else {
      expect(session.setThinking).toHaveBeenCalledWith('high');
    }
    expect(setConfig).toHaveBeenCalledWith({
      defaultModel: 'acme/next',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(modelMigrationState.acknowledged).toEqual({ 'acme/current': 'next' });
  });

  it.each([
    ['low', ['low', 'high'], 'low'],
    ['off', ['low', 'high'], 'off'],
    ['max', ['max'], 'high'],
  ] as const)('resolves a live %s effort on a thinking source to the migration effort', async (liveEffort, sourceEfforts, expected) => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'acme/next',
        thinkingEffort: expected,
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const setConfig = vi.fn(async () => ({}));
    const harness = makeHarness(session, {
      setConfig,
      getConfig: vi.fn(async () => ({ defaultModel: 'acme/current', thinking: { enabled: true } })),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await driver.setSession(session);
    installMigrationModels(driver);
    Object.assign(driver.state.appState.availableModels['acme/current']!, {
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: [...sourceEfforts],
    });
    driver.state.appState.thinkingEffort = liveEffort;

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(picker.render(100).join('\n')).toContain(`thinking ${expected}`);
    picker.handleInput('\r');
    await prompt;

    expect(session.setModel).toHaveBeenCalledWith('acme/next');
    if (expected === liveEffort) {
      expect(session.setThinking).not.toHaveBeenCalled();
    } else {
      expect(session.setThinking).toHaveBeenCalledWith(expected);
    }
    expect(setConfig).toHaveBeenCalledWith({
      defaultModel: 'acme/next',
      thinking: expected === 'off' ? { enabled: false } : { enabled: true, effort: expected },
    });
  });

  it.each(['draft', 'streaming', 'dialog', 'compaction', 'replay', 'external-editor', 'shutdown'])('defers the startup migration during %s', async (blockedBy) => {
    const session = makeSession();
    const setConfig = vi.fn();
    const driver = makeDriver(makeHarness(session, { setConfig }), makeStartupInput());
    installMigrationModels(driver);
    const startup = driver as unknown as {
      backgroundRefreshPromise: Promise<void>;
      finishStartup(replay: boolean): Promise<void>;
      setAppState(patch: Record<string, unknown>): void;
      restoreEditor(): void;
      setExternalEditorRunning(running: boolean): void;
      aborted: boolean;
    };
    let completeRefresh!: () => void;
    startup.backgroundRefreshPromise = new Promise((resolve) => { completeRefresh = resolve; });
    await startup.finishStartup(false);
    if (blockedBy === 'draft') driver.state.editor.setText('Please help');
    if (blockedBy === 'streaming') startup.setAppState({ streamingPhase: 'waiting' });
    if (blockedBy === 'dialog') driver.state.editorReplacementMounted = true;
    if (blockedBy === 'compaction') startup.setAppState({ isCompacting: true });
    if (blockedBy === 'replay') startup.setAppState({ isReplaying: true });
    if (blockedBy === 'external-editor') startup.setExternalEditorRunning(true);
    if (blockedBy === 'shutdown') startup.aborted = true;

    completeRefresh();
    await flushMigrationCheck();
    expect(driver.state.editorContainer.children[0]).not.toBeInstanceOf(ChoicePickerComponent);
    if (blockedBy === 'draft') {
      driver.state.editor.handleInput(' ');
      expect(driver.state.editor.getText()).toBe('Please help ');
      driver.state.editor.setText('');
    }
    if (blockedBy === 'streaming') startup.setAppState({ streamingPhase: 'idle' });
    if (blockedBy === 'dialog') startup.restoreEditor();
    if (blockedBy === 'compaction') startup.setAppState({ isCompacting: false });
    if (blockedBy === 'replay') startup.setAppState({ isReplaying: false });
    if (blockedBy === 'external-editor') startup.setExternalEditorRunning(false);
    await flushMigrationCheck();
    expect(session.setModel).not.toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
    if (blockedBy === 'shutdown') {
      expect(driver.state.editorReplacementMounted).toBe(false);
      return;
    }
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    picker.handleInput(' ');
    expect(driver.state.editorReplacementMounted).toBe(true);
    expect(modelMigrationState.acknowledged).toEqual({});
    picker.handleInput('\u001B');
    await flushMigrationCheck();
    expect(driver.state.editorReplacementMounted).toBe(false);
  });

  it('does not mount a migration while a submitted draft is creating its first session', async () => {
    const prompt = vi.fn(async () => {});
    const session = makeSession({
      prompt,
      getStatus: vi.fn(async () => ({
        model: 'acme/current', thinkingEffort: 'off', permission: 'manual', planMode: false,
        contextTokens: 10, maxContextTokens: 100, contextUsage: 0.1,
      })),
    });
    let completeCreation!: () => void;
    const harness = makeHarness(session, {
      createSession: vi.fn(async () => {
        await new Promise<void>((resolve) => { completeCreation = resolve; });
        return session;
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());
    installMigrationModels(driver);
    const startup = driver as unknown as {
      backgroundRefreshPromise: Promise<void>;
      finishStartup(replay: boolean): Promise<void>;
      persistInputHistory(text: string): Promise<void>;
      setAppState(patch: Record<string, unknown>): void;
    };
    vi.spyOn(startup, 'persistInputHistory').mockResolvedValue(undefined);
    driver.state.editor.setText('First prompt');
    startup.backgroundRefreshPromise = Promise.resolve();
    await startup.finishStartup(false);
    await flushMigrationCheck();

    driver.state.editor.handleInput('\r');
    await flushMigrationCheck();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(driver.state.editorReplacementMounted).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    completeCreation();
    await flushMigrationCheck();
    expect(prompt).toHaveBeenCalled();
    expect(driver.state.appState.streamingPhase).toBe('waiting');
    expect(driver.state.editorReplacementMounted).toBe(false);

    startup.setAppState({ streamingPhase: 'idle' });
    await flushMigrationCheck();
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    picker.handleInput('\u001B');
  });

  it('does not mount a migration while /new is replacing the session', async () => {
    const getStatus = vi.fn(async () => ({
      model: 'acme/current', thinkingEffort: 'off', permission: 'manual', planMode: false,
      contextTokens: 10, maxContextTokens: 100, contextUsage: 0.1,
    }));
    const oldSession = makeSession({ getStatus });
    const newSession = makeSession({ id: 'ses-2', getStatus });
    let completeCreation!: () => void;
    const harness = makeHarness(newSession, {
      createSession: vi.fn(async () => {
        await new Promise<void>((resolve) => { completeCreation = resolve; });
        return newSession;
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());
    installMigrationModels(driver);
    await driver.setSession(oldSession);
    const startup = driver as unknown as {
      modelMigration: { request(): void };
      createNewSession(): Promise<void>;
    };

    startup.modelMigration.request();
    const replacing = startup.createNewSession();
    await flushMigrationCheck();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(driver.state.editorReplacementMounted).toBe(false);
    expect(newSession.setModel).not.toHaveBeenCalled();

    completeCreation();
    await replacing;
    await flushMigrationCheck();
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    expect(picker.render(100).join('\n')).toContain('Model migration available');
    picker.handleInput('\u001B');
  });

  it.each([true, false])('checks migrations after the startup session picker (refresh first: %s)', async (refreshFirst) => {
    const session = makeSession({ getStatus: vi.fn(async () => ({
      model: 'acme/current', thinkingEffort: 'off', permission: 'manual', planMode: false,
      contextTokens: 10, maxContextTokens: 100, contextUsage: 0.1,
    })) });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{
        id: session.id, title: 'Picked', workDir: '/tmp/proj-a', updatedAt: Date.now(),
      }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));
    installMigrationModels(driver);
    harness.getConfig.mockResolvedValue({ models: driver.state.appState.availableModels } as never);
    const startup = driver as unknown as {
      authFlow: { refreshProviderModels(): Promise<unknown> };
      sessionReplay: { hydrateFromReplay(session: unknown): Promise<void> };
      initMainTui(): Promise<boolean>;
      finishStartup(replay: boolean): Promise<void>;
    };
    let completeRefresh!: () => void;
    vi.spyOn(startup.authFlow, 'refreshProviderModels').mockImplementation(async () => {
      await new Promise<void>((resolve) => { completeRefresh = resolve; });
      return { changed: [], unchanged: [], failed: [] };
    });
    vi.spyOn(startup.sessionReplay, 'hydrateFromReplay').mockResolvedValue(undefined);
    await startup.initMainTui();
    await startup.finishStartup(false);
    await flushMigrationCheck();
    expect(driver.state.activeDialog).toBe('session-picker');
    if (refreshFirst) {
      completeRefresh();
      await flushMigrationCheck();
      expect(driver.state.activeDialog).toBe('session-picker');
    }
    const sessionPicker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    sessionPicker.handleInput('\r');
    await flushMigrationCheck();
    expect(harness.resumeSession).toHaveBeenCalled();
    if (!refreshFirst) {
      expect(driver.state.editorReplacementMounted).toBe(false);
      completeRefresh();
      await flushMigrationCheck();
    }
    const migrationPicker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(migrationPicker).toBeInstanceOf(ChoicePickerComponent);
    expect(migrationPicker.render(100).join('\n')).toContain('Model migration available');
    migrationPicker.handleInput('\u001B');
  });

  it('keeps the current model and acknowledges the migration', async () => {
    const session = makeSession();
    const driver = makeDriver(makeHarness(session), makeStartupInput());
    await driver.setSession(session);
    installMigrationModels(driver);

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await prompt;

    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(driver.state.appState.model).toBe('acme/current');
    expect(modelMigrationState.acknowledged).toEqual({ 'acme/current': 'next' });
  });

  it('renders provider migration Markdown', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    installMigrationModels(driver);
    driver.state.appState.availableModels['acme/current']!.upgrade!.migrationMarkdown =
      '### Upgrade\n\nSwitch **current** to **next**.\n\n- Faster replies';

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    const output = picker.render(100).join('\n');
    expect(output).not.toContain('###');
    expect(output).not.toContain('**');
    expect(output).toContain('current');
    expect(output).toContain('next');
    picker.handleInput('\u001B');
    await prompt;
  });

  it('strips terminal control sequences from registry-provided migration text', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    installMigrationModels(driver);
    driver.state.appState.availableModels['acme/current']!.upgrade!.migrationMarkdown =
      'Move to next\u001B]0;pwned\u0007 soon\u001B[2J';
    driver.state.appState.availableModels['acme/next']!.displayName =
      'Next\u001B]8;;https://example.test\u0007';

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    const output = picker.render(100).join('\n');
    expect(output).toContain('Move to next soon');
    expect(output).toContain('Switch to Next');
    expect(output).not.toContain('pwned');
    expect(output).not.toContain('\u001B[2J');
    expect(output).not.toContain('example.test');
    picker.handleInput('\u001B');
    await prompt;
  });

  it.each([true, false])('warns about losing the prompt cache only when the conversation has history: %s', async (withHistory) => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    installMigrationModels(driver);
    if (withHistory) {
      driver.state.transcriptEntries.push({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'hello' });
    }

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    const output = picker.render(200).join('\n');
    if (withHistory) {
      expect(output).toContain('Switching models invalidates the existing prompt cache');
    } else {
      expect(output).not.toContain('prompt cache');
    }
    picker.handleInput('\u001B');
    await prompt;
  });

  it.each(['replace', 'restore'])('settles a displaced migration on editor %s without saving', async (action) => {
    const setConfig = vi.fn();
    const driver = makeDriver(makeHarness(makeSession(), { setConfig }), makeStartupInput());
    installMigrationModels(driver);
    const host = driver as unknown as KimiTUI;
    const onDisplaced = vi.fn();
    const settled = vi.fn();
    const prompt = maybeShowModelMigrationPrompt(host, {}, onDisplaced).then(settled);
    const oldPicker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    const replacement = new ChoicePickerComponent({
      title: 'Another dialog', options: [], onSelect: vi.fn(), onCancel: vi.fn(),
    });

    if (action === 'replace') host.mountEditorReplacement(replacement);
    else host.restoreEditor();
    await flushMigrationCheck();
    expect(settled).toHaveBeenCalledOnce();
    await prompt;
    expect(onDisplaced).toHaveBeenCalledOnce();
    oldPicker.handleInput('\r');
    oldPicker.handleInput('\u001B');
    expect(driver.state.editorContainer.children[0]).toBe(action === 'replace' ? replacement : driver.state.editor);
    expect(setConfig).not.toHaveBeenCalled();
    expect(modelMigrationState.acknowledged).toEqual({});
    host.restoreEditor();
    expect(onDisplaced).toHaveBeenCalledOnce();
  });

  it.each(['approval', 'question'])('requeues a migration displaced by a background %s', async (modal) => {
    const session = makeSession();
    const setConfig = vi.fn();
    const driver = makeDriver(makeHarness(session, { setConfig }), makeStartupInput({}, {
      notifications: { enabled: false, condition: 'unfocused' },
    }));
    installMigrationModels(driver);
    const host = driver as unknown as {
      modelMigration: { request(): void };
      showApprovalPanel(data: ApprovalPanelData): void;
      hideApprovalPanel(): void;
      showQuestionDialog(data: QuestionPanelData): void;
      hideQuestionDialog(): void;
      setAppState(patch: Record<string, unknown>): void;
      restoreEditor(): void;
    };
    host.modelMigration.request();
    await flushMigrationCheck();
    const oldPicker = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(oldPicker).toBeInstanceOf(ChoicePickerComponent);

    if (modal === 'approval') {
      host.showApprovalPanel({
        id: 'approval-1', tool_call_id: 'tool-1', tool_name: 'WriteFile',
        action: 'Write file', description: '', display: [],
        choices: [{ label: 'Approve once', response: 'approved' }],
      });
    } else {
      host.showQuestionDialog({
        id: 'question-1', tool_call_id: 'tool-1',
        questions: [{ question: 'Choose a path', multi_select: false, options: [{ label: 'A' }] }],
      });
    }
    const panel = driver.state.editorContainer.children[0] as Component & Focusable;
    await flushMigrationCheck();
    expect(panel).not.toBe(oldPicker);
    expect(panel.focused).toBe(true);
    oldPicker.handleInput('\r');
    oldPicker.handleInput('\u001B');
    expect(driver.state.editorContainer.children[0]).toBe(panel);
    expect(panel.focused).toBe(true);
    expect(session.setModel).not.toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
    expect(modelMigrationState.acknowledged).toEqual({});

    host.setAppState({ streamingPhase: 'waiting' });
    if (modal === 'approval') host.hideApprovalPanel();
    else host.hideQuestionDialog();
    await flushMigrationCheck();
    expect(driver.state.editorReplacementMounted).toBe(false);
    host.setAppState({ streamingPhase: 'idle' });
    await flushMigrationCheck();
    const retried = driver.state.editorContainer.children[0] as ChoicePickerComponent;
    expect(retried).toBeInstanceOf(ChoicePickerComponent);
    expect(retried).not.toBe(oldPicker);
    retried.handleInput('\u001B');
    host.restoreEditor();
    await flushMigrationCheck();
    expect(driver.state.editorReplacementMounted).toBe(false);
    expect(modelMigrationState.acknowledged).toEqual({});
  });

  it('cancels a model migration without acknowledging it', async () => {
    const session = makeSession();
    const driver = makeDriver(makeHarness(session), makeStartupInput());
    await driver.setSession(session);
    installMigrationModels(driver);

    const prompt = maybeShowModelMigrationPrompt(driver as any, {});
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B');
    await prompt;

    expect(session.setModel).not.toHaveBeenCalled();
    expect(driver.state.editorReplacementMounted).toBe(false);
    expect(modelMigrationState.acknowledged).toEqual({});
  });

  it('skips acknowledged migrations and targets outside the current provider', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    installMigrationModels(driver);

    await maybeShowModelMigrationPrompt(driver as any, { 'acme/current': 'next' });
    expect(driver.state.editorReplacementMounted).toBe(false);

    driver.state.appState.availableModels = {
      'acme/current': driver.state.appState.availableModels['acme/current']!,
      'other/next': {
        provider: 'other',
        model: 'next',
        maxContextSize: 100,
      },
    };
    await maybeShowModelMigrationPrompt(driver as any, {});
    expect(driver.state.editorReplacementMounted).toBe(false);
  });

  it('skips a startup migration acknowledged in the state file', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    installMigrationModels(driver);
    modelMigrationState.acknowledged = { 'acme/current': 'next' };
    const startup = driver as unknown as {
      backgroundRefreshPromise: Promise<void>;
      finishStartup(replay: boolean): Promise<void>;
    };
    startup.backgroundRefreshPromise = Promise.resolve();

    await startup.finishStartup(false);
    await flushMigrationCheck();

    expect(driver.state.editorReplacementMounted).toBe(false);
  });

  describe('when a refresh finds the default model dropped by its registry', () => {
    const retiredDefault = { from: 'acme/current', to: 'acme/next', from_display_name: 'Current' };

    async function refreshDroppingDefault(options: {
      readonly withSession: boolean;
      readonly model: string;
      readonly lazySessionThinking?: 'high';
    }) {
      const session = makeSession();
      const setConfig = vi.fn(async () => ({}));
      const harness = makeHarness(session, {
        setConfig,
        getConfig: vi.fn(async () => ({
          providers: { acme: { type: 'openai' } },
          models: { 'acme/next': { provider: 'acme', model: 'next', maxContextSize: 200 } },
          defaultModel: 'acme/next',
          thinking: { enabled: true, effort: 'medium' },
        })),
      });
      const driver = makeDriver(harness, makeStartupInput());
      if (options.withSession) await driver.setSession(session);
      installMigrationModels(driver);
      const remaining = { ...driver.state.appState.availableModels };
      delete remaining['acme/current'];
      driver.state.appState.model = options.model;
      driver.state.appState.thinkingEffort = options.lazySessionThinking ?? 'low';
      driver.state.appState.lazySessionThinking = options.lazySessionThinking;
      const showStatus = vi.spyOn(driver as any, 'showStatus');
      const startup = driver as unknown as {
        authFlow: { refreshProviderModels(): Promise<unknown> };
        refreshProviderModelsInBackground(): Promise<void>;
        modelMigration: { retry(): void };
      };
      vi.spyOn(startup.authFlow, 'refreshProviderModels').mockImplementation(async () => {
        driver.state.appState.availableModels = remaining;
        return { changed: [], unchanged: [], failed: [], retired_default: retiredDefault };
      });
      driver.state.activeDialog = 'session-picker';
      driver.state.editor.setText('draft');

      await startup.refreshProviderModelsInBackground();
      await flushMigrationCheck();
      expect(showStatus).not.toHaveBeenCalled();
      driver.state.activeDialog = null;
      startup.modelMigration.retry();
      await flushMigrationCheck();

      expect(showStatus).toHaveBeenCalledWith(
        'Current is no longer offered by its provider; the default model is now next.',
        'warning',
      );
      return { driver, session, setConfig };
    }

    it('warns once the session picker closes and leaves the live session to the engine', async () => {
      const { session, setConfig } = await refreshDroppingDefault({
        withSession: true,
        model: 'acme/current',
      });

      expect(session.setModel).not.toHaveBeenCalled();
      expect(session.setThinking).not.toHaveBeenCalled();
      expect(setConfig).not.toHaveBeenCalled();
    });

    it('moves a session-less selection onto the new default with the configured thinking', async () => {
      const { driver, setConfig } = await refreshDroppingDefault({
        withSession: false,
        model: 'acme/current',
      });

      expect(driver.state.appState).toMatchObject({
        model: 'acme/next',
        maxContextTokens: 200,
        thinkingEffort: 'medium',
        lazySessionThinking: undefined,
      });
      expect(setConfig).not.toHaveBeenCalled();
    });

    it('keeps a session-only effort picked before the first prompt', async () => {
      const { driver } = await refreshDroppingDefault({
        withSession: false,
        model: 'acme/current',
        lazySessionThinking: 'high',
      });

      expect(driver.state.appState).toMatchObject({
        model: 'acme/next',
        thinkingEffort: 'high',
        lazySessionThinking: 'high',
      });
    });

    it('leaves a session-less selection on another model alone', async () => {
      const { driver } = await refreshDroppingDefault({ withSession: false, model: 'acme/next' });

      expect(driver.state.appState).toMatchObject({
        model: 'acme/next',
        thinkingEffort: 'low',
        lazySessionThinking: undefined,
      });
    });
  });

  it('preserves fresh startup yolo and plan intent after OAuth login', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'yolo',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session);
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: false },
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
      })),
      createSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
    });
  });

  it('does not override active session thinking when configured thinking is enabled after OAuth login', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: true },
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
      })),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    await driver.setSession(session);
    await driver.syncRuntimeState(session);
    expect(driver.state.appState.thinkingEffort).toBe('off');

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(session.setModel).toHaveBeenCalledWith('k2');
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      model: 'k2',
      thinkingEffort: 'off',
      maxContextTokens: 100,
    });
    expect(harness.track).toHaveBeenCalledWith('login', {
      provider: 'managed:kimi-code',
      method: 'oauth',
      already_logged_in: false,
    });
  });

  it('tracks login with already_logged_in when a token already exists', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(harness.auth.login).toHaveBeenCalledWith(
      'managed:kimi-code',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onDeviceCode: expect.any(Function),
      }),
    );
    expect(harness.track).toHaveBeenCalledWith('login', {
      provider: 'managed:kimi-code',
      method: 'oauth',
      already_logged_in: true,
    });
  });

  it('logs login failures with session context', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const session = makeSession();
    const loginError = new Error('Failed to list Kimi Code models (HTTP 402).');
    const harness = makeHarness(session, {
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async () => {
          throw loginError;
        }),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    try {
      await expect(driver.init()).resolves.toBe(false);
      await driver.setSession(session);
      await driver.syncRuntimeState(session);

      vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
      await handleLoginCommand(driver as any);

      expect(harness.auth.login).toHaveBeenCalledWith(
        'managed:kimi-code',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onDeviceCode: expect.any(Function),
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        'login failed',
        expect.objectContaining({
          providerName: 'managed:kimi-code',
          alreadyLoggedIn: false,
          sessionId: 'ses-1',
          error: expect.objectContaining({
            message: 'Failed to list Kimi Code models (HTTP 402).',
          }),
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('tracks logout while preserving the active session model', async () => {
    let loggedOut = false;
    const session = makeSession();
    const logout = vi.fn(async () => {
      loggedOut = true;
    });
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () =>
        loggedOut
          ? { models: {}, providers: {} }
          : {
              models: {
                k2: {
                  provider: 'managed:kimi-code',
                  model: 'moonshot-v1',
                  maxContextSize: 100,
                },
              },
              providers: { 'managed:kimi-code': { type: 'kimi' } },
            },
      ),
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout,
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    await driver.setSession(session);
    await driver.syncRuntimeState(session);
    harness.track.mockClear();

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith('managed:kimi-code');
    expect(session.close).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      sessionTitle: 'Session title',
      contextTokens: 10,
      maxContextTokens: 100,
      availableModels: {},
      availableProviders: {},
    });
    expect(harness.track).toHaveBeenCalledWith('logout', { provider: 'managed:kimi-code' });
  });

  it('clears the config-derived model when logging out without an active session', async () => {
    let loggedOut = false;
    const logout = vi.fn(async () => {
      loggedOut = true;
    });
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () =>
        loggedOut
          ? { models: {}, providers: {} }
          : {
              models: {
                k2: {
                  provider: 'managed:kimi-code',
                  model: 'moonshot-v1',
                  maxContextSize: 100,
                },
              },
              providers: { 'managed:kimi-code': { type: 'kimi' } },
              defaultModel: 'k2',
            },
      ),
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout,
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState.model).toBe('k2');

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      availableProviders: {},
    });
  });

  it('keeps the active session when logging out a different provider', async () => {
    const session = makeSession();
    const removeProvider = vi.fn(async () => {});
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: 'managed:kimi-code', model: 'moonshot-v1', maxContextSize: 100 },
        },
        providers: {
          'managed:kimi-code': { type: 'kimi' },
          openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1' },
        },
      })),
      removeProvider,
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    await driver.setSession(session);
    await driver.syncRuntimeState(session);
    harness.track.mockClear();

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('openai');
    await handleLogoutCommand(driver as any);

    expect(removeProvider).toHaveBeenCalledWith('openai');
    expect(harness.auth.logout).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
    });
    expect(harness.track).toHaveBeenCalledWith('logout', { provider: 'openai' });
  });

  it('can log out a stale managed entry even after the OAuth token is gone', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: 'managed:kimi-code', model: 'moonshot-v1', maxContextSize: 100 },
        },
        providers: { 'managed:kimi-code': { type: 'kimi' } },
      })),
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: false }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith('managed:kimi-code');
  });

  it('starts TUI without replaying when --continue needs OAuth login', async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
      resumeSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-latest',
      replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('starts TUI without replaying when an explicit resume needs OAuth login', async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
      resumeSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: 'ses-target' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-target',
      replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
    });
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('disposes terminal focus/theme tracking on the kimi migrate exit', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver;
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    await driver.start();

    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('disposes terminal tracking when post-migration startup fails', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: false,
    }) as unknown as MigrateExitDriver;
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    vi.spyOn(driver, 'initMainTui').mockRejectedValue(new Error('resume boom'));

    await expect(driver.start()).rejects.toThrow('resume boom');

    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
  });

  it('checks workspace trust before entering the migration screen', async () => {
    const getWorkspaceTrustInfo = vi.fn(async () => ({
      trusted: true,
      gatedMcpServers: [],
      gatedAdditionalDirs: [], additionalDirSources: [], warnings: [],
      instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
      }));
    const harness = makeHarness(makeSession(), { getWorkspaceTrustInfo });
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver;
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    const migrationSpy = vi
      .spyOn(driver, 'runMigrationScreen')
      .mockResolvedValue({ decision: 'later' });
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    await driver.start();

    expect(getWorkspaceTrustInfo).toHaveBeenCalledWith('/tmp/proj-a');
    expect(getWorkspaceTrustInfo.mock.invocationCallOrder[0]!).toBeLessThan(
      migrationSpy.mock.invocationCallOrder[0]!,
    );
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('prompts for workspace trust before migrating an untrusted workspace', async () => {
    const getWorkspaceTrustInfo = vi.fn(async () => ({
      trusted: false,
      gatedMcpServers: [],
      gatedAdditionalDirs: [], additionalDirSources: [], warnings: [],
      instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
      }));
    const trustWorkspace = vi.fn(async () => {});
    const harness = makeHarness(makeSession(), { getWorkspaceTrustInfo, trustWorkspace });
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver & {
      mountEditorReplacement(panel: { handleInput(data: string): void }): void;
    };
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    const migrationSpy = vi
      .spyOn(driver, 'runMigrationScreen')
      .mockResolvedValue({ decision: 'later' });
    const mountSpy = vi.spyOn(driver, 'mountEditorReplacement');
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    const startPromise = driver.start();
    await vi.waitFor(() => {
      expect(mountSpy).toHaveBeenCalled();
    });
    mountSpy.mock.calls[0]![0].handleInput('\u001B[A');
    mountSpy.mock.calls[0]![0].handleInput('\r');
    await startPromise;

    expect(trustWorkspace).toHaveBeenCalledWith('/tmp/proj-a');
    expect(getWorkspaceTrustInfo.mock.invocationCallOrder[0]!).toBeLessThan(
      migrationSpy.mock.invocationCallOrder[0]!,
    );
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('prompts for workspace trust when trust info cannot be read', async () => {
    const getWorkspaceTrustInfo = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const trustWorkspace = vi.fn(async () => {});
    const harness = makeHarness(makeSession(), { getWorkspaceTrustInfo, trustWorkspace });
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver & {
      mountEditorReplacement(panel: { handleInput(data: string): void }): void;
    };
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    const mountSpy = vi.spyOn(driver, 'mountEditorReplacement');
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    const startPromise = driver.start();
    await vi.waitFor(() => {
      expect(mountSpy).toHaveBeenCalled();
    });
    mountSpy.mock.calls[0]![0].handleInput('\u001B[A');
    mountSpy.mock.calls[0]![0].handleInput('\r');
    await startPromise;

    expect(trustWorkspace).toHaveBeenCalledWith('/tmp/proj-a');
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('continues startup when persisting trust fails', async () => {
    const getWorkspaceTrustInfo = vi.fn(async () => ({
      trusted: false,
      gatedMcpServers: [],
      gatedAdditionalDirs: [], additionalDirSources: [], warnings: [],
      instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
      }));
    const trustWorkspace = vi.fn(async (): Promise<void> => {
      throw new Error('disk full');
    });
    const harness = makeHarness(makeSession(), { getWorkspaceTrustInfo, trustWorkspace });
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver & {
      mountEditorReplacement(panel: { handleInput(data: string): void }): void;
    };
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    const migrationSpy = vi
      .spyOn(driver, 'runMigrationScreen')
      .mockResolvedValue({ decision: 'later' });
    const mountSpy = vi.spyOn(driver, 'mountEditorReplacement');
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    const startPromise = driver.start();
    await vi.waitFor(() => {
      expect(mountSpy).toHaveBeenCalled();
    });
    mountSpy.mock.calls[0]![0].handleInput('\u001B[A');
    mountSpy.mock.calls[0]![0].handleInput('\r');
    await startPromise;

    expect(trustWorkspace).toHaveBeenCalledWith('/tmp/proj-a');
    expect(migrationSpy).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('does not mount the footer when resuming a missing session fails', async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => []),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'missing-session' }),
    ) as unknown as MigrateExitDriver;

    await expect(driver.initMainTui()).rejects.toThrow('Session "missing-session" not found.');
    expect(uiContainsFooter(driver)).toBe(false);
  });

  it('mounts the footer once startup reaches the main TUI', async () => {
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'ses-target' }),
    ) as unknown as MigrateExitDriver;

    expect(uiContainsFooter(driver)).toBe(false);

    await driver.initMainTui();

    expect(uiContainsFooter(driver)).toBe(true);
  });

  it('renders the banner below the welcome message after it loads', async () => {
    const banner = {
      key: 'new-banner',
      tag: 'New',
      mainText: 'Banner main',
      subText: null,
      display: 'always' as const,
    };
    const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'ses-target' }),
    ) as unknown as MigrateExitDriver;

    await driver.initMainTui();

    await vi.waitFor(() => {
      expect(
        driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
      ).toBe(true);
    });

    const welcomeIndex = driver.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const bannerIndex = driver.state.transcriptContainer.children.findIndex(
      (child) => child instanceof BannerComponent,
    );
    expect(welcomeIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBe(welcomeIndex + 1);

    loadSpy.mockRestore();
  });

  it('writes display state after rendering a once banner', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'kimi-startup-banner-'));
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      const banner = {
        key: 'once-banner',
        tag: null,
        mainText: 'Banner main',
        subText: null,
        display: 'once' as const,
      };
      const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
      const session = makeSession({ id: 'ses-target' });
      const harness = makeHarness(session, {
        listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
      });
      const driver = makeDriver(
        harness,
        makeStartupInput({ session: 'ses-target' }),
      ) as unknown as MigrateExitDriver;

      await driver.initMainTui();

      await vi.waitFor(() => {
        expect(
          driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
        ).toBe(true);
      });

      await vi.waitFor(
        async () => {
          const state = await readBannerDisplayState();
          expect(state.shown['once-banner']?.lastShownAt).toBeDefined();
        },
        { timeout: 5000 },
      );
      await expect(readBannerDisplayState()).resolves.toMatchObject({
        version: 1,
        shown: {
          'once-banner': {
            lastShownAt: expect.any(String),
          },
        },
      });

      loadSpy.mockRestore();
    } finally {
      process.env = { ...originalEnv };
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write display state for an always banner', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'kimi-startup-banner-'));
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      const banner = {
        key: 'always-banner',
        tag: null,
        mainText: 'Banner main',
        subText: null,
        display: 'always' as const,
      };
      const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
      const session = makeSession({ id: 'ses-target' });
      const harness = makeHarness(session, {
        listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
      });
      const driver = makeDriver(
        harness,
        makeStartupInput({ session: 'ses-target' }),
      ) as unknown as MigrateExitDriver;

      await driver.initMainTui();

      await vi.waitFor(() => {
        expect(
          driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
        ).toBe(true);
      });

      await expect(readBannerDisplayState()).resolves.toEqual({
        version: 1,
        shown: {},
      });

      loadSpy.mockRestore();
    } finally {
      process.env = { ...originalEnv };
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still loads the banner when the access-token lookup fails', async () => {
    const banner = {
      key: 'new-banner',
      tag: null,
      mainText: 'Banner main',
      subText: null,
      display: 'always' as const,
    };
    let capturedAudience: unknown;
    const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockImplementation(async (options) => {
      capturedAudience = await options?.audience;
      return banner;
    });
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    harness.auth.getCachedAccessToken = vi.fn(async () => {
      throw new Error('credential storage broken');
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'ses-target' }),
    ) as unknown as MigrateExitDriver;

    await driver.initMainTui();

    await vi.waitFor(() => {
      expect(
        driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
      ).toBe(true);
    });
    expect(capturedAudience).toEqual({ login: 'unknown' });

    loadSpy.mockRestore();
  });

  it('resumes a startup session when Windows workdir uses backslashes', async () => {
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: 'C:/Users/kimi/project' }]),
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ session: 'ses-target' }),
      workDir: String.raw`C:\Users\kimi\project`,
    });

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.listSessions).toHaveBeenCalledWith({
      sessionId: 'ses-target',
      workDir: String.raw`C:\Users\kimi\project`,
    });
    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-target',
      replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
    });
    expect(driver.state.appState.sessionId).toBe('ses-target');
  });
});

function uiContainsFooter(driver: StartupDriver): boolean {
  const target: unknown = driver.state.footer;
  const visit = (node: unknown): boolean => {
    if (node === target) return true;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) && children.some(visit);
  };
  return visit(driver.state.ui);
}

describe('survey telemetry gate wiring', () => {
  function surveyGateTelemetryDisabled(input: KimiTUIStartupInput): boolean {
    const driver = new KimiTUI(makeHarness() as never, input);
    const controller = driver.surveyController as unknown as {
      deps: { telemetryDisabled?: () => boolean };
    };
    return controller.deps.telemetryDisabled?.() ?? false;
  }

  it('treats the runtime config opt-out as telemetry-disabled', () => {
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', '');
    try {
      expect(
        surveyGateTelemetryDisabled({ ...makeStartupInput(), telemetryDisabled: true }),
      ).toBe(true);
      expect(surveyGateTelemetryDisabled(makeStartupInput())).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('treats the env kill switch as telemetry-disabled', () => {
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', '1');
    try {
      expect(surveyGateTelemetryDisabled(makeStartupInput())).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
