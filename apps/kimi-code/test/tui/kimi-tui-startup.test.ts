import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log, type GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import { describe, expect, it, vi } from 'vitest';

import { BannerProvider } from '#/tui/banner/banner-provider';
import { readBannerDisplayState } from '#/tui/banner/state';
import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import { promptPlatformSelection, promptLogoutProviderSelection } from '#/tui/commands/prompts';
import { BannerComponent } from '#/tui/components/chrome/banner';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
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

const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

interface StartupDriver {
  state: TUIState;
  init(): Promise<boolean>;
  handleLoginCommand(): Promise<void>;
  handleLogoutCommand(): Promise<void>;
  stop(exitCode?: number): Promise<void>;
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
  return {
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
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
    ...overrides,
  };
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
  it('creates a fresh session from startup flags and syncs runtime state', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'yolo',
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 200,
        contextUsage: 0.125,
      })),
    });
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a',
      permission: 'yolo',
      planMode: true,
    });
    expect(session.setApprovalHandler).toHaveBeenCalledOnce();
    expect(session.setQuestionHandler).toHaveBeenCalledOnce();
    expect(harness.setTelemetryContext).toHaveBeenCalledWith({ sessionId: null });
    expect(harness.setTelemetryContext).toHaveBeenLastCalledWith({ sessionId: 'ses-1' });
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
      contextTokens: 25,
      maxContextTokens: 200,
      contextUsage: 0.125,
      sessionTitle: 'Session title',
    });
  });

  it('resumes the latest session for --continue and marks history for replay', async () => {
    const session = makeSession({ id: 'ses-latest' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }, { id: 'ses-old' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'ses-latest' });
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
    expect(driver.state.appState.goal).toEqual(goal);

    await driver.closeSession('test close');

    expect(driver.state.appState.goal).toBeNull();
  });

  it('passes the CLI model override when creating a fresh startup session', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ model: 'kimi-code/k2.5' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a',
      model: 'kimi-code/k2.5',
      permission: undefined,
      planMode: undefined,
    });
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
        { providerId: "new-models", providerName: "New Models", added: 2, removed: 0 },
        { providerId: "removed-models", providerName: "Removed Models", added: 0, removed: 3 },
        { providerId: "metadata-only", providerName: "Metadata Only", added: 0, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });

    await (driver as any).refreshProviderModelsInBackground();

    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledWith("New Models · +2 models.");
  });

  it("starts TUI without a session when fresh startup needs OAuth login", async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect((driver as any).startupNotice).toContain('OAuth login expired');
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
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
      model: '',
      permissionMode: 'yolo',
      planMode: true,
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(1, {
      workDir: '/tmp/proj-a',
      permission: 'yolo',
      planMode: true,
    });
    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: 'off',
      permission: 'yolo',
      planMode: true,
    });
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
    });
  });

  it('does not force manual permission after OAuth login without --yolo', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'auto',
        planMode: false,
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
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: 'off',
      permission: undefined,
      planMode: undefined,
    });
    expect(driver.state.appState).toMatchObject({
      permissionMode: 'auto',
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
    expect(driver.state.appState.thinkingEffort).toBe('off');

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(session.setModel).toHaveBeenCalledWith('k2');
    // `thinking.enabled === true` means "leave the session's current thinking
    // level alone" — only an explicit `enabled === false` forces `'off'`.
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

  it('tracks logout after managed credentials and session state are cleared', async () => {
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

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith('managed:kimi-code');
    expect(session.close).toHaveBeenCalledOnce();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    expect(harness.track).toHaveBeenCalledWith('logout', { provider: 'managed:kimi-code' });
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
        // Token gone (e.g. credentials file deleted) but the managed entry
        // is still sitting in config.providers.
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

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'ses-latest' });
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

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'ses-target' });
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
    // pi-tui start/stop and focus tracking touch the real TTY — stub the I/O.
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    // The migration screen would await user input; resolve it immediately.
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    await driver.start();

    // `kimi migrate` exits via process.exit; startEventLoop() installed focus
    // tracking, so the exit path must dispose it — otherwise the terminal
    // keeps emitting focus/OSC sequences after the command finishes.
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
    // The migration screen resolves "later"; startup then continues into
    // initMainTui(), which fails (e.g. a session-resume error).
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    vi.spyOn(driver, 'initMainTui').mockRejectedValue(new Error('resume boom'));

    await expect(driver.start()).rejects.toThrow('resume boom');

    // The focus tracking installed by startEventLoop() must be torn down
    // before the error propagates — not left active after the process exits.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
  });

  it('keeps non-login startup session errors fatal', async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw new Error('provider config is invalid');
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).rejects.toThrow('provider config is invalid');
  });

  it('does not mount the footer when resuming a missing session fails', async () => {
    // Regression: a stray pre-startEventLoop render used to paint the footer
    // (cwd/git + "context:" statusline) to the terminal before the fatal
    // error, leaving it stranded above the error message. The footer must not
    // be in the layout tree when initMainTui() throws.
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

    // Not mounted until init() succeeds.
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

    // The banner is rendered directly below the welcome panel so it appears
    // above later status messages such as MCP server connection summaries.
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

      // writeBannerDisplayState runs after renderBanner; on Windows the atomic
      // write can lag behind the render, so wait for the state to land before
      // asserting it.
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
    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'ses-target' });
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
