import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
  ErrorCodes,
  KimiError,
  log,
  type GoalSnapshot,
  type WorktreeListing,
  type WorktreeRemovalCheck,
} from '@moonshot-ai/kimi-code-sdk';
import { fetchOpenPlatformModels } from '@moonshot-ai/kimi-code-oauth';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import type { Component, Focusable, ProgramStatus } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BannerProvider } from '#/tui/banner/banner-provider';
import { readBannerDisplayState } from '#/tui/banner/state';
import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import { promptPlatformSelection, promptLogoutProviderSelection } from '#/tui/commands/prompts';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { WorktreePanelComponent } from '#/tui/components/dialogs/worktree-panel';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { BannerComponent } from '#/tui/components/chrome/banner';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import type { FooterGitBinding } from '#/tui/components/chrome/footer';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import { maybeShowModelMigrationPrompt } from '#/tui/controllers/model-migration';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import { REPLAY_FETCH_TURN_LIMIT } from '#/tui/utils/message-replay';
import type { SessionRow } from '#/tui/components/dialogs/session-picker';
import { SESSION_LIST_PAGE_SIZE } from '#/tui/constant/kimi-tui';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { mountFooter } from '#/tui/tui-state';
import { quoteShellArg } from '#/utils/shell-quote';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { getInputHistoryFile } from '#/utils/paths';
import type { WorkLocation } from '#/tui/types';
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_LIGHT,
} from '#/tui/utils/terminal-theme';

vi.mock('@moonshot-ai/kimi-code-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-oauth')>();
  return { ...actual, fetchOpenPlatformModels: vi.fn() };
});
vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return { ...actual, promptPlatformSelection: vi.fn(), promptLogoutProviderSelection: vi.fn() };
});
vi.mock('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));
vi.mock('#/utils/open-url', () => ({ openUrl: vi.fn() }));
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
  refreshSlashCommandAutocomplete(): void;
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
      environment: undefined,
      ...cliOptions,
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
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
    setStaleReloadHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    getGoal: vi.fn(async () => ({ goal: null })),
    onEvent: vi.fn(() => () => {}),
    getResumeState: vi.fn(() => null),
    listSkills: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    getEnvironment: vi.fn(async () => ({ environmentId: 'local' })),
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
    resolveSessionEnvironment: vi.fn(async (options: { environmentId?: string; environmentCwd?: string }) => ({ environmentId: options.environmentId ?? 'local', cwd: options.environmentCwd })),
    onConfigSectionChanged: vi.fn(() => vi.fn()),
    createSession: vi.fn(
      async (_options?: {
        environmentId?: string;
        environmentCwd?: string;
        agentProfile?: string;
      }) => session,
    ),
    resumeSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    getWorkspaceAdditionalDirs: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => null),
    getGitPullRequest: vi.fn(async () => null),
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
  it('loads persisted and startup additional directories before the lazy session', async () => {
    const getWorkspaceAdditionalDirs = vi.fn(async () => ['/tmp/extra', '/tmp/cli-extra']);
    const harness = makeHarness(makeSession(), { getWorkspaceAdditionalDirs });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ model: 'k2' }),
      additionalDirs: ['../cli-extra'],
    });

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();

    const expectedDirs = ['/tmp/extra', '../cli-extra'].map((dir) =>
      resolve('/tmp/proj-a', dir).replaceAll('\\', '/'),
    );
    expect(getWorkspaceAdditionalDirs).toHaveBeenCalledWith('/tmp/proj-a');
    expect(driver.state.appState.additionalDirs).toEqual(expectedDirs);
    expect(driver.state.appState.sessionId).toBe('');
    expect(harness.createSession).not.toHaveBeenCalled();
    const showStatus = vi.spyOn(
      driver as unknown as { showStatus: (msg: string) => void },
      'showStatus',
    );
    (driver as unknown as { handleUserInput(text: string): void }).handleUserInput('/add-dir list');
    await vi.waitFor(() => {
      expect(showStatus).toHaveBeenCalledWith(expect.stringContaining(expectedDirs[0]!));
    });
  });

  it('loads workspace additional directories for picker startup', async () => {
    const harness = makeHarness(makeSession(), {
      getWorkspaceAdditionalDirs: vi.fn(async () => ['/tmp/extra']),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();

    expect(driver.state.startupState).toBe('picker');
    expect(driver.state.appState.additionalDirs).toEqual([
      resolve('/tmp/extra').replaceAll('\\', '/'),
    ]);
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.resumeSession).not.toHaveBeenCalled();
  });

  it('does not silently drop startup directories when workspace directory loading fails', async () => {
    const harness = makeHarness(makeSession(), {
      getWorkspaceAdditionalDirs: vi.fn(async () => {
        throw new Error('invalid workspace directories');
      }),
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ model: 'k2' }),
      additionalDirs: ['../cli-extra'],
    });

    await expect(
      (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui(),
    ).rejects.toThrow('invalid workspace directories');
    expect(driver.state.appState.additionalDirs).toEqual(['../cli-extra']);
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('does not reuse the startup workspace snapshot when creating the first session', async () => {
    const getWorkspaceAdditionalDirs = vi.fn(async () => ['/tmp/removed']);
    const harness = makeHarness(makeSession(), { getWorkspaceAdditionalDirs });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    getWorkspaceAdditionalDirs.mockResolvedValue([]);

    await (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession();

    expect(getWorkspaceAdditionalDirs).toHaveBeenCalledTimes(1);
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ additionalDirs: expect.anything() }),
    );
  });

  it('continues sessionless startup when Git Bash is unavailable', async () => {
    const error = Object.assign(new Error('Git Bash missing'), {
      code: ErrorCodes.SHELL_GIT_BASH_NOT_FOUND,
    });
    const harness = makeHarness(makeSession(), {
      getWorkspaceAdditionalDirs: vi.fn(async () => {
        throw error;
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));

    await expect(
      (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui(),
    ).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect(harness.createSession).not.toHaveBeenCalled();
    expect((driver as unknown as { startupNotice?: string }).startupNotice).toContain(
      'Git Bash missing',
    );
  });

  it('cleans up the started event loop when workspace directory loading fails', async () => {
    const harness = makeHarness(makeSession(), {
      getWorkspaceAdditionalDirs: vi.fn(async () => {
        throw new Error('invalid workspace directories');
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' })) as unknown as MigrateExitDriver;
    vi.spyOn(
      driver as unknown as { maybeRunWorkspaceTrustPrompt(): Promise<boolean> },
      'maybeRunWorkspaceTrustPrompt',
    ).mockResolvedValue(true);
    const stop = vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    const dispose = vi.fn();
    driver.terminalFocusTrackingDispose = dispose;

    await expect(driver.start()).rejects.toThrow('invalid workspace directories');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('expands home directories for mentions but preserves them for session creation', async () => {
    const harness = makeHarness(makeSession(), {
      getWorkspaceAdditionalDirs: vi.fn(async () => []),
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ model: 'k2' }),
      additionalDirs: ['~/extra'],
    });

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    expect(driver.state.appState.additionalDirs).toEqual([
      join(homedir(), 'extra').replaceAll('\\', '/'),
    ]);

    await (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession();
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ additionalDirs: ['~/extra'] }),
    );
  });

  it('passes only explicit startup directories to resumed sessions', async () => {
    const session = makeSession({ id: 'ses-resume' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-resume', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ continue: true, model: 'k2' }),
      additionalDirs: ['~/extra'],
    });

    await driver.init();

    expect(harness.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ additionalDirs: ['~/extra'] }),
    );
  });

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
    mountFooter(driver.state);

    expect(driver.state.dockContainer?.children).toHaveLength(7);
    expect(driver.state.activityContainer.render(80).map((line) => line.trim())).toEqual(['']);
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

  it('reports the legacy survey setting migration and applies the migrated value', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-tui-survey-home-'));
    const previousHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = homeDir;
    try {
      writeFileSync(join(homeDir, 'tui.toml'), 'disable_feedback_survey = true\n');
      const setConfig = vi.fn(async () => ({}));
      const harness = makeHarness(makeSession(), {
        getConfig: vi.fn(async () => ({
          models: {
            k2: { model: 'moonshot-v1', maxContextSize: 100 },
          },
        })),
        setConfig,
      });
      const driver = makeDriver(harness, {
        ...makeStartupInput({}, { disableFeedbackSurvey: true }),
      });

      await expect(driver.init()).resolves.toBe(false);
      await (
        driver as unknown as { finishStartup(shouldReplayHistory: boolean): Promise<void> }
      ).finishStartup(false);

      await vi.waitFor(() => {
        expect(harness.track).toHaveBeenCalledWith('survey_setting_migration', {
          legacy: true,
          configured: 'absent',
          action: 'written',
        });
      });
      expect(setConfig).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
      expect(driver.state.appState.disableFeedbackSurvey).toBe(true);
      expect(readFileSync(join(homeDir, 'tui.toml'), 'utf-8')).not.toContain(
        'disable_feedback_survey',
      );
    } finally {
      if (previousHome === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = previousHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    { legacy: true, configured: false, action: 'kept_existing', reportedConfigured: false },
    { legacy: false, configured: undefined, action: 'dropped_default', reportedConfigured: 'absent' },
  ])(
    'reports $action for the legacy survey setting migration',
    async ({ legacy, configured, action, reportedConfigured }) => {
      const homeDir = mkdtempSync(join(tmpdir(), 'kimi-tui-survey-home-'));
      const previousHome = process.env['KIMI_CODE_HOME'];
      process.env['KIMI_CODE_HOME'] = homeDir;
      try {
        writeFileSync(join(homeDir, 'tui.toml'), `disable_feedback_survey = ${String(legacy)}\n`);
        const setConfig = vi.fn(async () => ({}));
        const harness = makeHarness(makeSession(), {
          getConfig: vi.fn(async () => ({
            models: {
              k2: { model: 'moonshot-v1', maxContextSize: 100 },
            },
            disableFeedbackSurvey: configured,
          })),
          setConfig,
        });
        const driver = makeDriver(harness, {
          ...makeStartupInput({}, { disableFeedbackSurvey: legacy }),
        });

        await expect(driver.init()).resolves.toBe(false);
        await (
          driver as unknown as { finishStartup(shouldReplayHistory: boolean): Promise<void> }
        ).finishStartup(false);

        await vi.waitFor(() => {
          expect(harness.track).toHaveBeenCalledWith('survey_setting_migration', {
            legacy,
            configured: reportedConfigured,
            action,
          });
        });
        expect(setConfig).not.toHaveBeenCalled();
        expect(readFileSync(join(homeDir, 'tui.toml'), 'utf-8')).not.toContain(
          'disable_feedback_survey',
        );
      } finally {
        if (previousHome === undefined) delete process.env['KIMI_CODE_HOME'];
        else process.env['KIMI_CODE_HOME'] = previousHome;
        rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it('does not report the survey setting migration without a legacy key', async () => {
    const harness = makeHarness(makeSession());
    const driver = makeDriver(harness, { ...makeStartupInput() });

    await expect(driver.init()).resolves.toBe(false);
    await (
      driver as unknown as { finishStartup(shouldReplayHistory: boolean): Promise<void> }
    ).finishStartup(false);

    await vi.waitFor(() => {
      expect(harness.getConfig).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.track).not.toHaveBeenCalledWith(
      'survey_setting_migration',
      expect.anything(),
    );
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

  it('keeps open-platform login blocked across prompts until cancellation', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    const statusWrites = vi.spyOn(driver.state.terminal, 'setProgramStatus').mockImplementation(() => {});
    const rootStatus = () => statusWrites.mock.calls
      .findLast(([status]) => status.id === undefined)?.[0];
    let respond!: (models: Awaited<ReturnType<typeof fetchOpenPlatformModels>>) => void;
    const fetchModelsMock = vi.mocked(fetchOpenPlatformModels);
    fetchModelsMock.mockImplementation(() => new Promise((resolve) => {
      respond = resolve;
    }));
    try {
      vi.mocked(promptPlatformSelection).mockResolvedValue('moonshot-cn');
      const login = handleLoginCommand(driver as any);
      await vi.waitFor(() => {
        expect(driver.state.editorContainer.children[0]).toBeInstanceOf(ApiKeyInputDialogComponent);
      });
      expect(rootStatus()).toMatchObject({ state: 'blocked', kind: 'auth' });

      const apiKeyDialog = driver.state.editorContainer.children[0] as ApiKeyInputDialogComponent;
      apiKeyDialog.handleInput('YOUR_API_KEY');
      apiKeyDialog.handleInput('\r');
      await vi.waitFor(() => {
        expect(fetchModelsMock).toHaveBeenCalledOnce();
      });
      const statusDuringVerification = rootStatus();

      respond([{
        id: 'kimi-k2.5',
        contextLength: 262144,
        supportsReasoning: true,
        supportsImageIn: false,
        supportsVideoIn: false,
      }]);
      await vi.waitFor(() => {
        expect(driver.state.editorContainer.children[0]).toBeInstanceOf(ModelSelectorComponent);
      });
      const statusDuringModelSelection = rootStatus();

      (driver.state.editorContainer.children[0] as ModelSelectorComponent).handleInput('\u001B');
      await login;
      expect(statusDuringVerification).toMatchObject({ state: 'blocked', kind: 'auth' });
      expect(statusDuringModelSelection).toMatchObject({ state: 'blocked', kind: 'auth' });
      expect(rootStatus()).toMatchObject({ state: 'idle' });
    } finally {
      fetchModelsMock.mockReset();
    }
  });

  it('clears auth required after OAuth succeeds with an existing session model and no default model', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    driver.state.appState.model = 'session-only-model';
    const statusWrites = vi.spyOn(driver.state.terminal, 'setProgramStatus').mockImplementation(() => {});
    (driver as any).programStatus.setAuthRequired(true);
    const rootStatus = () => statusWrites.mock.calls
      .findLast(([status]) => status.id === undefined)?.[0];

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(rootStatus()).toEqual({ state: 'idle', app: 'kimi-code' });
  });

  it('keeps auth required when login is cancelled before authentication succeeds', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    const statusWrites = vi.spyOn(driver.state.terminal, 'setProgramStatus').mockImplementation(() => {});
    (driver as any).programStatus.setAuthRequired(true);
    const rootStatus = () => statusWrites.mock.calls
      .findLast(([status]) => status.id === undefined)?.[0];

    vi.mocked(promptPlatformSelection).mockResolvedValue(undefined);
    await handleLoginCommand(driver as any);

    expect(rootStatus()).toMatchObject({ state: 'blocked', kind: 'auth' });
  });

  it('keeps auth required after OAuth succeeds when no model is available', async () => {
    const driver = makeDriver(makeHarness(), makeStartupInput());
    driver.state.appState.model = '';
    const statusWrites = vi.spyOn(driver.state.terminal, 'setProgramStatus').mockImplementation(() => {});
    (driver as any).programStatus.setAuthRequired(true);
    const rootStatus = () => statusWrites.mock.calls
      .findLast(([status]) => status.id === undefined)?.[0];

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(rootStatus()).toMatchObject({ state: 'blocked', kind: 'auth' });
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

  it('pre-creates the startup environment session with its cwd override (v2)', async () => {
    const harness = makeHarness(makeSession(), {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
        defaultModel: 'k2',
      })),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ environment: 'dev-box', environmentCwd: '/remote/work' }),
    );

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'dev-box', environmentCwd: '/remote/work' }),
    );
  });

  it('labels an explicit remote before creation defaults have loaded', () => {
    const driver = makeDriver(makeHarness(), makeStartupInput({ environment: 'dev-box' }));
    expect((driver as unknown as { startupProgressLabel(): string }).startupProgressLabel()).toBe('Connecting to dev-box…');
  });

  it('pre-creates an engine-resolved remote default without a CLI environment flag', async () => {
    const harness = makeHarness(makeSession(), {
      resolveSessionEnvironment: vi.fn(async () => ({ environmentId: 'dev-box', cwd: '/remote/work' })),
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await driver.init();
    expect(harness.resolveSessionEnvironment).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a', environmentId: undefined, environmentCwd: undefined,
    });
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect((driver as unknown as { startupProgressLabel(): string }).startupProgressLabel()).toBe('Connecting to dev-box…');
  });

  it('offers no remote @ candidates while the first remote session is still connecting', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const session = makeSession();
    const suggestFiles = vi.fn(async () => ({ items: [], truncated: false }));
    const harness = makeHarness(session, {
      resolveSessionEnvironment: vi.fn(async () => ({ environmentId: 'dev-box', cwd: '/remote/work' })),
      createSession: vi.fn(async () => { await pending; return session; }),
      suggestFiles,
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    try {
      await driver.init();
      const providerSpy = vi.spyOn(driver.state.editor, 'setAutocompleteProvider');
      driver.refreshSlashCommandAutocomplete();
      const provider = providerSpy.mock.calls.at(-1)![0];
      await provider.getSuggestions(['@app'], 0, 4, { signal: new AbortController().signal });
      expect(suggestFiles).not.toHaveBeenCalled();
    } finally {
      release();
      await (driver as unknown as { waitForSessionAssembly(): Promise<void> }).waitForSessionAssembly();
    }
  });

  it('reads footer git state through the engine, skipping a remote binding until its session exists', async () => {
    type GitBindingDriver = { footerGitBinding(state: TUIState['appState']): FooterGitBinding | null };
    const localHarness = makeHarness();
    const local = makeDriver(localHarness, makeStartupInput());
    const localBinding = (local as unknown as GitBindingDriver).footerGitBinding(local.state.appState);
    expect(localBinding?.source.localWorkDir).toBe(local.state.appState.workDir);
    await localBinding?.source.status();
    expect(localHarness.getGitStatus).toHaveBeenCalledWith(local.state.appState.workDir, { sessionId: undefined });

    const remoteHarness = makeHarness();
    const remote = makeDriver(remoteHarness, makeStartupInput({ environment: 'dev-box' }));
    const driver = remote as unknown as GitBindingDriver;
    expect(driver.footerGitBinding(remote.state.appState)).toBeNull();

    const connected = {
      ...remote.state.appState,
      sessionId: 'ses-remote',
      environment: { environmentId: 'dev-box', type: 'ssh' as const, status: 'ready' as const, cwd: '/remote/work' },
    };
    const remoteBinding = driver.footerGitBinding(connected);
    expect(remoteBinding?.source.localWorkDir).toBeUndefined();
    await remoteBinding?.source.pullRequest();
    expect(remoteHarness.getGitPullRequest).toHaveBeenCalledWith(remote.state.appState.workDir, { sessionId: 'ses-remote' });
    expect(driver.footerGitBinding({ ...connected, environment: { ...connected.environment, status: 'disconnected' } })?.key)
      .toBe(remoteBinding?.key);
  });

  it('completes remote @ mentions through the live session', async () => {
    const suggestFiles = vi.fn(async () => ({
      items: [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', matchPositions: [0] }],
      truncated: false,
    }));
    const session = makeSession();
    const harness = makeHarness(session, { suggestFiles });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await driver.init();
    await driver.setSession(session);
    driver.state.appState.environment = {
      environmentId: 'dev-box',
      type: 'ssh',
      status: 'ready',
      cwd: '/remote/work',
    };
    const setAutocompleteProvider = vi.spyOn(driver.state.editor, 'setAutocompleteProvider');
    driver.refreshSlashCommandAutocomplete();
    const provider = setAutocompleteProvider.mock.calls.at(-1)?.[0];

    const result = await provider!.getSuggestions(['@app'], 0, 4, {
      signal: new AbortController().signal,
    });

    expect(suggestFiles).toHaveBeenCalledWith(driver.state.appState.workDir, {
      query: 'app',
      sessionId: session.id,
      followGitignore: false,
    });
    expect(result?.items[0]).toMatchObject({ value: '@src/app.ts' });
  });

  it('binds /new to the current session environment and cwd, not the startup flag', async () => {
    const session = makeSession({
      getEnvironment: vi.fn(async () => ({
        environmentId: 'dev-box',
        cwd: '/remote/custom',
      })),
    });
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
        defaultModel: 'k2',
      })),
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);
    driver.state.appState.agentProfile = 'reviewer';
    (driver as unknown as { session: typeof session }).session = session;

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();

    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'dev-box',
        environmentCwd: '/remote/custom',
      }),
    );
    expect(harness.createSession.mock.calls[0]?.[0]).not.toHaveProperty('agentProfile');
  });

  it('passes an explicit local binding so /new does not fall back to the config default', async () => {
    const session = makeSession({
      getEnvironment: vi.fn(async () => ({ environmentId: 'local', cwd: '/tmp/proj-a' })),
    });
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
        defaultModel: 'k2',
      })),
    });
    const driver = makeDriver(harness, makeStartupInput({ model: 'k2' }));
    await expect(driver.init()).resolves.toBe(false);
    (driver as unknown as { session: typeof session }).session = session;

    await (driver as unknown as { createNewSession(): Promise<void> }).createNewSession();

    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'local', environmentCwd: '/tmp/proj-a' }),
    );
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
    driver.state.appState.additionalDirs = ['/tmp/live-extra'];
    vi.spyOn(driver as unknown as { hasSessionContent(): boolean }, 'hasSessionContent')
      .mockReturnValue(true);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0018');
    picker.handleInput('y');

    await vi.waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('ses-current');
    });
    expect(driver.state.activeDialog).toBe('session-picker');
    resolveDelete();

    await vi.waitFor(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(2);
    });
    expect(harness.createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ additionalDirs: ['/tmp/live-extra'] }),
    );
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
    onTestFinished(() => {
      driver.state.theme.setTerminalBackground(undefined);
    });

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
    expect(driver.state.ui.requestRender).toHaveBeenCalledOnce();

    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).toHaveBeenCalled();
  });

  it('tracks terminal background for explicit themes without changing their palette', () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput()) as unknown as ThemeTrackingDriver;
    const { listeners, write, addInputListener } = captureInputListeners(driver);
    onTestFinished(() => {
      driver.state.theme.setTerminalBackground(undefined);
    });
    const palette = driver.state.theme.palette;

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.theme.palette).toBe(palette);
    expect(driver.state.ui.requestRender).toHaveBeenCalledOnce();
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

  it('restores auth status after OAuth reissues a device code', async () => {
    const statuses: ProgramStatus[] = [];
    const rootStatus = () => statuses.findLast((status) => status.id === undefined);
    let statusDuringRenewal: ProgramStatus | undefined;
    const harness = makeHarness(makeSession(), {
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async (
          _provider: string,
          options: {
            onDeviceCode: (auth: { verificationUriComplete: string; userCode: string }) => void;
          },
        ) => {
          options.onDeviceCode({
            verificationUriComplete: 'https://example.com/device',
            userCode: 'FIRST',
          });
          options.onDeviceCode({
            verificationUriComplete: 'https://example.com/device',
            userCode: 'SECOND',
          });
          statusDuringRenewal = rootStatus();
        }),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);
    vi.spyOn(driver.state.terminal, 'setProgramStatus').mockImplementation((status) => {
      statuses.push(status);
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(statusDuringRenewal).toMatchObject({ state: 'blocked', kind: 'auth' });
    expect(rootStatus()).toEqual({ state: 'idle', app: 'kimi-code' });
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

  it('removes the startup progress row once ready and keeps the failure row', async () => {
    const startDriver = (initMainTui: () => Promise<boolean>): MigrateExitDriver => {
      const driver = makeDriver(makeHarness(), makeStartupInput()) as unknown as MigrateExitDriver;
      vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
      vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
      vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
      vi.spyOn(driver, 'initMainTui').mockImplementation(initMainTui);
      vi.spyOn(driver as unknown as { finishStartup(): Promise<void> }, 'finishStartup').mockResolvedValue();
      return driver;
    };
    const transcriptText = (driver: MigrateExitDriver): string =>
      driver.state.transcriptContainer.children.flatMap((child) => child.render(80)).join('\n');

    const ready = startDriver(async () => false);
    await ready.start();
    expect(ready.state.transcriptContainer.children.some((child) => child instanceof MoonLoader)).toBe(false);
    expect(transcriptText(ready)).not.toContain('Ready.');

    const failed = startDriver(async () => {
      throw new Error('startup boom');
    });
    await expect(failed.start()).rejects.toThrow('startup boom');
    expect(transcriptText(failed)).toContain('Startup failed.');
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
      ...makeStartupInput({ environment: 'fake-box', environmentCwd: '/remote/work' }),
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

    expect(getWorkspaceTrustInfo).toHaveBeenCalledWith('/tmp/proj-a', {
      additionalDirs: [],
      environmentId: 'fake-box',
      environmentCwd: '/remote/work',
    });
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

describe('animation frame interval wiring', () => {
  it('runs animation frames at the startup frame rate, and every 120 ms without one', () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const frameGaps = (animationFrameRate?: number): number[] => {
      const { ui } = makeDriver(makeHarness(), { ...makeStartupInput(), animationFrameRate }).state;
      const times: number[] = [];
      const step = (time: number): void => {
        times.push(time);
        if (times.length < 4) ui.requestAnimationFrame(step);
      };
      ui.requestAnimationFrame(step);
      vi.advanceTimersByTime(1_000);
      return times.slice(1).map((time, index) => time - (times[index] ?? 0));
    };

    expect(frameGaps()).toEqual([120, 120, 120]);
    expect(frameGaps(20)).toEqual([50, 50, 50]);
  });
});

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

describe('KimiTUI resume location', () => {
  interface ResumeDriver extends StartupDriver {
    start(): Promise<void>;
    onExit?: (code?: number) => Promise<void>;
    runMigrationScreen(plan: unknown): Promise<unknown>;
    locateStartupSession(): Promise<void>;
    finishStartup(shouldReplayHistory: boolean): Promise<void>;
    handleSessionPickerSelect(session: SessionRow, applyStartupModes: boolean): Promise<void>;
    ensureSession(): Promise<unknown>;
    sendNormalUserInput(text: string): Promise<void>;
  }

  const WORKTREE_ON = [{ id: 'worktree', enabled: true }];

  function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  function places() {
    const project = tempDir('kimi-resume-project-');
    const worktree = tempDir('kimi-resume-worktree-');
    const elsewhere = tempDir('kimi-resume-elsewhere-');
    const resolveWorkLocation = vi.fn(async (cwd: string) =>
      cwd === worktree
        ? { workDir: project, cwd, worktree: { root: worktree, name: 'x', repoRoot: project } }
        : { workDir: cwd, cwd },
    );
    return { project, worktree, elsewhere, resolveWorkLocation };
  }

  function transcriptText(driver: StartupDriver): string {
    return stripVTControlCharacters(driver.state.transcriptContainer.render(240).join('\n'));
  }

  it('keeps rejecting a --session target from another directory while the worktree flag is off', async () => {
    const { project, elsewhere } = places();
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: 'ses-other', workDir: project, projectWorkDir: project }]),
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ session: 'ses-other', model: 'k2' }),
      workDir: elsewhere,
    }) as ResumeDriver;
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    onTestFinished(() => {
      stderrWrite.mockRestore();
    });

    await driver.locateStartupSession();
    await expect(driver.init()).rejects.toThrow('Session "ses-other" was created under a different directory.');

    expect(harness.listSessions).toHaveBeenCalledWith({ sessionId: 'ses-other', workDir: elsewhere });
    expect(String(stderrWrite.mock.calls[0]?.[0])).toContain(`cd "${project}" && kimi -r ses-other`);
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.appState.workDir).toBe(elsewhere);
  });

  it('checks workspace trust for the project of a --session target from another directory', async () => {
    const { project, worktree, elsewhere, resolveWorkLocation } = places();
    const harness = makeHarness(makeSession(), {
      getExperimentalFeatures: vi.fn(async () => WORKTREE_ON),
      listSessions: vi.fn(async () => [{ id: 'ses-wt', workDir: worktree, projectWorkDir: project }]),
      resolveWorkLocation,
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ session: 'ses-wt', model: 'k2' }),
      workDir: elsewhere,
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as ResumeDriver;
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    driver.onExit = vi.fn(async () => {});

    await driver.start();

    expect(harness.listSessions).toHaveBeenCalledWith({ sessionId: 'ses-wt' });
    expect(harness.getWorkspaceTrustInfo).toHaveBeenCalledWith(project, expect.anything());
    expect(harness.getWorkspaceTrustInfo).not.toHaveBeenCalledWith(elsewhere, expect.anything());
  });

  it('resumes a --session target from another directory in its own location', async () => {
    const { project, worktree, elsewhere, resolveWorkLocation } = places();
    const harness = makeHarness(makeSession({ id: 'ses-wt' }), {
      getExperimentalFeatures: vi.fn(async () => WORKTREE_ON),
      listSessions: vi.fn(async () => [{ id: 'ses-wt', workDir: worktree, projectWorkDir: project }]),
      resolveWorkLocation,
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ session: 'ses-wt', model: 'k2' }),
      workDir: elsewhere,
    }) as ResumeDriver;

    await driver.locateStartupSession();
    await expect(driver.init()).resolves.toBe(true);
    await driver.finishStartup(true);

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'ses-wt', replayTurnLimit: REPLAY_FETCH_TURN_LIMIT });
    expect(driver.state.appState).toMatchObject({ workDir: project, cwd: worktree, worktree: { name: 'x' } });
    expect(transcriptText(driver)).toContain(`Switched to ${worktree} to resume this session.`);
  });

  it('continues the latest non-worktree session in the source directory and only its own session in a worktree', async () => {
    const { project, worktree, resolveWorkLocation } = places();
    const gone = `${worktree}-gone`;
    const listSessionsPage = vi.fn(async () => ({
      items: [
        { id: 'ses-gone', workDir: gone, projectWorkDir: project },
        { id: 'ses-wt', workDir: worktree, projectWorkDir: project },
        { id: 'ses-main', workDir: project, projectWorkDir: project },
      ],
      nextCursor: undefined,
    }));
    const listWorktrees = vi.fn(async () => ({
      repoRoot: project,
      worktrees: [
        { path: gone, name: 'gone', head: undefined, branch: undefined, missing: true },
        { path: worktree, name: 'x', head: undefined, branch: undefined, missing: false },
      ],
    }));
    const overrides = {
      getExperimentalFeatures: vi.fn(async () => WORKTREE_ON),
      listSessionsPage,
      listWorktrees,
      resolveWorkLocation,
    };

    const sourceHarness = makeHarness(makeSession({ id: 'ses-main' }), overrides);
    const source = makeDriver(sourceHarness, { ...makeStartupInput({ continue: true, model: 'k2' }), workDir: project });
    await expect(source.init()).resolves.toBe(true);
    expect(sourceHarness.resumeSession).toHaveBeenCalledWith({ id: 'ses-main', replayTurnLimit: REPLAY_FETCH_TURN_LIMIT });
    expect(source.state.appState).toMatchObject({ workDir: project, cwd: project });

    const worktreeHarness = makeHarness(makeSession({ id: 'ses-wt' }), overrides);
    const inWorktree = makeDriver(worktreeHarness, { ...makeStartupInput({ continue: true, model: 'k2' }), workDir: worktree });
    await expect(inWorktree.init()).resolves.toBe(true);
    expect(worktreeHarness.resumeSession).toHaveBeenCalledWith({ id: 'ses-wt', replayTurnLimit: REPLAY_FETCH_TURN_LIMIT });
    expect(listSessionsPage).toHaveBeenLastCalledWith({ workDir: project, limit: SESSION_LIST_PAGE_SIZE, before: undefined });
    expect(inWorktree.state.appState).toMatchObject({ workDir: project, cwd: worktree, worktree: { name: 'x' } });
  });

  it('resumes a picker session from another directory in its own location', async () => {
    const { project, worktree, elsewhere, resolveWorkLocation } = places();
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-wt' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      getExperimentalFeatures: vi.fn(async () => WORKTREE_ON),
      resumeSession,
      resolveWorkLocation,
    });
    const driver = makeDriver(harness, { ...makeStartupInput({ model: 'k2' }), workDir: elsewhere }) as ResumeDriver;
    await driver.init();
    copyTextToClipboardMock.mockClear();

    await driver.handleSessionPickerSelect(
      { id: 'ses-wt', title: null, work_dir: worktree, project_work_dir: project, updated_at: 0 },
      true,
    );

    expect(resumeSession).toHaveBeenCalledWith({ id: 'ses-wt', replayTurnLimit: REPLAY_FETCH_TURN_LIMIT });
    expect(copyTextToClipboardMock).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({ workDir: project, cwd: worktree, worktree: { name: 'x' } });
    expect(transcriptText(driver)).toContain(`Switched to ${worktree} to resume this session.`);
  });

  it('opens a session whose working directory is missing read-only and resumes it once the directory is back', async () => {
    const { project, elsewhere, resolveWorkLocation } = places();
    const missing = join(project, 'gone-worktree');
    const readSessionHistory = vi.fn(async () => ({ replay: [] }));
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-gone' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      getExperimentalFeatures: vi.fn(async () => WORKTREE_ON),
      listSessions: vi.fn(async () => [{ id: 'ses-gone', title: 'Gone work', workDir: missing, projectWorkDir: project }]),
      readSessionHistory,
      resumeSession,
      resolveWorkLocation,
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ session: 'ses-gone', model: 'k2' }),
      workDir: elsewhere,
    }) as ResumeDriver;
    const editorText = () => stripVTControlCharacters(driver.state.editor.render(120).join('\n'));
    const notice = `This session's working directory is missing: ${missing}. You can read the conversation, but not continue it.`;

    await driver.locateStartupSession();
    await expect(driver.init()).resolves.toBe(false);
    await driver.finishStartup(false);

    expect(readSessionHistory).toHaveBeenCalledWith({ id: 'ses-gone' });
    expect(resumeSession).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({ sessionId: 'ses-gone', sessionTitle: 'Gone work', workDir: elsewhere });
    expect(transcriptText(driver)).toContain(notice);
    expect(editorText()).toContain('Read-only: the working directory is missing');

    await expect(driver.ensureSession()).resolves.toBeUndefined();
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(transcriptText(driver).split(notice)).toHaveLength(3);

    Object.assign(driver.state.appState, { model: '' });
    await driver.sendNormalUserInput('try to continue');
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(transcriptText(driver).split(notice)).toHaveLength(4);
    expect(transcriptText(driver)).not.toContain('LLM not set');

    mkdirSync(missing);
    await driver.handleSessionPickerSelect(
      { id: 'ses-gone', title: 'Gone work', work_dir: missing, project_work_dir: project, updated_at: 0 },
      false,
    );

    expect(resumeSession).toHaveBeenCalledWith({ id: 'ses-gone', replayTurnLimit: REPLAY_FETCH_TURN_LIMIT });
    expect(driver.state.appState).toMatchObject({ workDir: project, cwd: missing });
    expect(editorText()).not.toContain('Read-only');
  });
});

describe('KimiTUI work location', () => {
  interface LocationDriver extends StartupDriver {
    initMainTui(): Promise<boolean>;
    applyWorkLocation(location: WorkLocation): Promise<void>;
    refreshWorkLocation(): Promise<void>;
    ensureSession(): Promise<unknown>;
    createNewSession(): Promise<void>;
    persistInputHistory(text: string): Promise<void>;
  }

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  async function startAt(
    workDir: string,
    harness: ReturnType<typeof makeHarness>,
    cliOptions: Partial<KimiTUIStartupInput['cliOptions']> = {},
  ): Promise<LocationDriver> {
    const driver = makeDriver(harness, { ...makeStartupInput({ model: 'k2', ...cliOptions }), workDir }) as LocationDriver;
    await driver.initMainTui();
    return driver;
  }

  it('shows the applied working directory in the footer, the welcome panel, and the git badge', async () => {
    const project = tempDir('kimi-location-project-');
    const worktree = tempDir('kimi-location-worktree-');
    const harness = makeHarness(makeSession(), {
      getGitStatus: vi.fn(async (dir: string) => ({
        branch: dir === worktree ? 'worktree-branch' : 'project-branch',
        dirty: false,
        ahead: 0,
        behind: 0,
        additions: 0,
        deletions: 0,
      })),
    });
    const driver = await startAt(project, harness);
    const footerLine = () => stripVTControlCharacters(driver.state.footer.render(200)[0] ?? '');
    const welcomeText = () => {
      const welcome = driver.state.transcriptContainer.children.find((child) => child instanceof WelcomeComponent);
      return stripVTControlCharacters(welcome?.render(200).join('\n') ?? '');
    };
    await vi.waitFor(() => {
      expect(footerLine()).toContain('project-branch');
    });
    expect(footerLine()).toContain(basename(project));
    expect(welcomeText()).toContain(`Directory: ${project}`);

    await driver.applyWorkLocation({
      workDir: project,
      cwd: worktree,
      worktree: { root: worktree, name: 'wt', repoRoot: project },
    });

    await vi.waitFor(() => {
      expect(footerLine()).toContain('worktree-branch');
    });
    expect(footerLine()).toContain('worktree wt');
    expect(footerLine()).not.toContain(basename(project));
    expect(welcomeText()).toContain(`Directory: ${worktree}`);
    expect(welcomeText()).toContain(`Worktree:  wt of ${project}`);
  });

  it('re-resolves a Kimi worktree when the worktree flag turns on or off mid-session', async () => {
    const project = tempDir('kimi-location-project-');
    const worktree = tempDir('kimi-location-worktree-');
    let flagOn = false;
    const harness = makeHarness(makeSession(), {
      resolveWorkLocation: vi.fn(async (cwd: string) =>
        flagOn && cwd === worktree
          ? { workDir: project, cwd, worktree: { root: worktree, name: 'wt', repoRoot: project } }
          : { workDir: cwd, cwd },
      ),
    });
    const driver = await startAt(worktree, harness);
    expect(driver.state.appState.worktree).toBeUndefined();

    flagOn = true;
    await driver.refreshWorkLocation();
    expect(driver.state.appState).toMatchObject({
      workDir: project,
      cwd: worktree,
      worktree: { root: worktree, name: 'wt', repoRoot: project },
    });

    flagOn = false;
    await driver.refreshWorkLocation();
    expect(driver.state.appState).toMatchObject({ workDir: worktree, cwd: worktree });
    expect(driver.state.appState.worktree).toBeUndefined();
  });

  it('blocks sending while a worktree is being created and cancels it on Esc', async () => {
    const project = tempDir('kimi-location-project-');
    let signal: AbortSignal | undefined;
    const harness = makeHarness(makeSession(), {
      createWorktree: vi.fn(
        (_input: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal = options.signal;
            options.signal.addEventListener('abort', () => {
              reject(new KimiError(ErrorCodes.WORKTREE_CANCELLED, 'Worktree operation cancelled.'));
            });
          }),
      ),
    });
    const driver = await startAt(project, harness);
    const tui = driver as unknown as {
      worktreeCreation: { run(request: { name?: string }): Promise<void> };
      handleUserInput(text: string): void;
    };
    const transcriptText = () =>
      stripVTControlCharacters(driver.state.transcriptContainer.children.map((child) => child.render(200).join('\n')).join('\n'));
    const running = tui.worktreeCreation.run({ name: 'fix-login' });
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });

    tui.handleUserInput('hello');
    expect(driver.state.editor.getText()).toBe('hello');
    expect(transcriptText()).toContain('Wait for the worktree to finish setting up.');
    expect(harness.createSession).not.toHaveBeenCalled();

    driver.state.editor.setText('');
    driver.state.editor.handleInput('\u001B');
    await running;
    expect(signal?.aborted).toBe(true);
    expect(transcriptText()).toContain(`Cancelled. Staying in ${project}.`);
  });

  it('starts in the worktree it was launched from', async () => {
    const project = tempDir('kimi-location-project-');
    const worktree = tempDir('kimi-location-worktree-');
    const harness = makeHarness(makeSession());
    const driver = makeDriver(harness, {
      ...makeStartupInput({ model: 'k2' }),
      workDir: project,
      cwd: join(worktree, 'pkg'),
      worktree: { root: worktree, name: 'wt', repoRoot: project },
    }) as LocationDriver;
    await driver.initMainTui();

    expect(stripVTControlCharacters(driver.state.footer.render(200)[0] ?? '')).toContain('worktree wt/pkg');
    expect(harness.resolveSessionEnvironment).toHaveBeenLastCalledWith({
      workDir: project, environmentId: 'local', environmentCwd: join(worktree, 'pkg'),
    });
    await driver.ensureSession();
    expect(harness.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ workDir: project, environmentId: 'local', environmentCwd: join(worktree, 'pkg') }),
    );
  });

  it('completes @ mentions from the applied working directory', async () => {
    const project = tempDir('kimi-location-project-');
    const worktree = tempDir('kimi-location-worktree-');
    writeFileSync(join(project, 'project-notes.txt'), '');
    writeFileSync(join(worktree, 'worktree-notes.txt'), '');
    const driver = makeDriver(makeHarness(), { ...makeStartupInput({ model: 'k2' }), workDir: project }) as LocationDriver;
    const setAutocompleteProvider = vi.spyOn(driver.state.editor, 'setAutocompleteProvider');
    await driver.initMainTui();
    const mentionValues = async () => {
      const provider = setAutocompleteProvider.mock.calls.at(-1)![0];
      const result = await provider.getSuggestions(['@notes'], 0, 6, { signal: new AbortController().signal, force: true });
      return result?.items.map((item) => item.value) ?? [];
    };
    expect(await mentionValues()).toContain('@project-notes.txt');

    await driver.applyWorkLocation({ workDir: project, cwd: worktree });

    const values = await mentionValues();
    expect(values).toContain('@worktree-notes.txt');
    expect(values).not.toContain('@project-notes.txt');
  });

  it('keeps the input history file for the same project and swaps it with the project directory', async () => {
    vi.stubEnv('KIMI_CODE_HOME', tempDir('kimi-location-home-'));
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const projectA = tempDir('kimi-location-a-');
    const projectB = tempDir('kimi-location-b-');
    const worktree = tempDir('kimi-location-worktree-');
    await appendInputHistory(getInputHistoryFile(projectA), { content: 'typed in A' });
    await appendInputHistory(getInputHistoryFile(projectB), { content: 'typed in B' });
    const driver = await startAt(projectA, makeHarness());
    const recall = () => {
      driver.state.editor.setText('');
      driver.state.editor.handleInput('\u001B[A');
      return driver.state.editor.getText();
    };
    const persisted = async (dir: string) => (await loadInputHistory(getInputHistoryFile(dir))).map((entry) => entry.content);
    await vi.waitFor(() => {
      expect(recall()).toBe('typed in A');
    });

    await driver.applyWorkLocation({ workDir: projectA, cwd: worktree });
    expect(recall()).toBe('typed in A');
    await driver.persistInputHistory('typed in the worktree');
    expect(await persisted(projectA)).toEqual(['typed in A', 'typed in the worktree']);

    await driver.applyWorkLocation({ workDir: projectB, cwd: projectB });
    expect(recall()).toBe('typed in B');
    await driver.persistInputHistory('typed in B again');
    expect(await persisted(projectB)).toEqual(['typed in B', 'typed in B again']);
    expect(await persisted(projectA)).toEqual(['typed in A', 'typed in the worktree']);
  });

  it('creates sessions in the working directory while the project directory owns them', async () => {
    const project = tempDir('kimi-location-project-');
    const worktree = tempDir('kimi-location-worktree-');
    const session = makeSession({
      getEnvironment: vi.fn(async () => ({ environmentId: 'local', cwd: project })),
    });
    const harness = makeHarness(session);
    const driver = await startAt(project, harness);
    expect(harness.resolveSessionEnvironment).toHaveBeenLastCalledWith({
      workDir: project, environmentId: undefined, environmentCwd: undefined,
    });

    await driver.applyWorkLocation({ workDir: project, cwd: worktree });
    expect(harness.resolveSessionEnvironment).toHaveBeenLastCalledWith({
      workDir: project, environmentId: 'local', environmentCwd: worktree,
    });

    await driver.ensureSession();
    await driver.createNewSession();
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    for (const [options] of harness.createSession.mock.calls) {
      expect(options).toMatchObject({ workDir: project, environmentId: 'local', environmentCwd: worktree });
    }
  });

  it('keeps an explicit --environment when the working directory changes', async () => {
    const project = tempDir('kimi-location-project-');
    const worktree = tempDir('kimi-location-worktree-');
    const session = makeSession({
      getEnvironment: vi.fn(async () => ({ environmentId: 'dev-box', cwd: '/remote/work' })),
    });
    const harness = makeHarness(session);
    const driver = await startAt(project, harness, { environment: 'dev-box', environmentCwd: '/remote/work' });
    await (driver as unknown as { waitForSessionAssembly(): Promise<void> }).waitForSessionAssembly();

    await driver.applyWorkLocation({ workDir: project, cwd: worktree });
    await driver.createNewSession();

    expect(harness.resolveSessionEnvironment).toHaveBeenLastCalledWith({
      workDir: project, environmentId: 'dev-box', environmentCwd: '/remote/work',
    });
    expect(harness.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ workDir: project, environmentId: 'dev-box', environmentCwd: '/remote/work' }),
    );
  });

  describe('/worktree', () => {
    const DOWN = '\u001B[B';
    const UP = '\u001B[A';
    const ENTER = '\r';

    function removalCheck(worktree: string, overrides: Partial<WorktreeRemovalCheck> = {}): WorktreeRemovalCheck {
      return {
        path: worktree,
        missing: false,
        branch: undefined,
        uncommittedFiles: 0,
        uniqueCommits: 0,
        openSessionIds: [],
        closedSessionCount: 0,
        ...overrides,
      };
    }

    function worktreeHarness(project: string, worktree: string, session = makeSession()) {
      const mocks = {
        listWorktrees: vi.fn(
          async (_cwd: string): Promise<WorktreeListing> => ({
            repoRoot: project,
            worktrees: [{ path: worktree, name: 'fix-login', head: 'abc1234', branch: undefined, missing: false }],
          }),
        ),
        inspectWorktreeRemoval: vi.fn(async (_input: unknown): Promise<WorktreeRemovalCheck> => removalCheck(worktree)),
        removeWorktree: vi.fn(async (_input: unknown): Promise<void> => {}),
      };
      const harness = makeHarness(session, {
        getExperimentalFeatures: vi.fn(async () => [{ id: 'worktree', enabled: true }]),
        ...mocks,
      });
      let created = 0;
      harness.createSession.mockImplementation(async () => {
        created += 1;
        return created === 1 ? session : makeSession({ id: `ses-${String(created)}` });
      });
      return { harness, ...mocks };
    }

    function transcriptText(driver: LocationDriver): string {
      return stripVTControlCharacters(
        driver.state.transcriptContainer.children.map((child) => child.render(200).join('\n')).join('\n'),
      );
    }

    function slot<T>(driver: LocationDriver, type: abstract new (...args: never[]) => T): T | undefined {
      const mounted = driver.state.editorContainer.children[0];
      return mounted instanceof type ? mounted : undefined;
    }

    function runCommand(driver: LocationDriver, text: string): void {
      (driver as unknown as { handleUserInput(text: string): void }).handleUserInput(text);
    }

    async function openPanel(driver: LocationDriver): Promise<WorktreePanelComponent> {
      runCommand(driver, '/worktree');
      await vi.waitFor(() => {
        expect(slot(driver, WorktreePanelComponent)).toBeDefined();
      });
      return slot(driver, WorktreePanelComponent)!;
    }

    async function choose(driver: LocationDriver, keys: readonly string[]): Promise<string> {
      await vi.waitFor(() => {
        expect(slot(driver, ChoicePickerComponent)).toBeDefined();
      });
      const picker = slot(driver, ChoicePickerComponent)!;
      const text = stripVTControlCharacters(picker.render(200).join('\n'));
      for (const key of keys) picker.handleInput(key);
      return text;
    }

    function panelText(driver: LocationDriver): string {
      return stripVTControlCharacters(slot(driver, WorktreePanelComponent)?.render(200).join('\n') ?? '');
    }

    it('is listed only while the worktree experiment is on', async () => {
      const project = tempDir('kimi-location-project-');
      const commands = (driver: LocationDriver): string[] =>
        (driver as unknown as { getSlashCommands(): readonly { name: string }[] })
          .getSlashCommands()
          .map((command) => command.name);

      expect(commands(await startAt(project, makeHarness()))).not.toContain('worktree');
      expect(commands(await startAt(project, worktreeHarness(project, project).harness))).toContain('worktree');
    });

    it('starts a fresh session in the chosen checkout even when the current session has a conversation', async () => {
      const project = tempDir('kimi-location-project-');
      const worktree = tempDir('kimi-location-worktree-');
      const { harness } = worktreeHarness(project, worktree);
      const driver = await startAt(project, harness);
      await driver.ensureSession();
      driver.state.transcriptEntries.push({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'hello' });

      const panel = await openPanel(driver);
      panel.handleInput(DOWN);
      panel.handleInput(ENTER);

      await vi.waitFor(() => {
        expect(transcriptText(driver)).toContain('Now working in worktree fix-login');
      });
      expect(slot(driver, WorktreePanelComponent)).toBeUndefined();
      expect(harness.createSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ workDir: project, environmentId: 'local', environmentCwd: worktree }),
      );
      expect(driver.state.appState).toMatchObject({
        sessionId: 'ses-2',
        workDir: project,
        cwd: worktree,
        worktree: { root: worktree, name: 'fix-login', repoRoot: project },
      });

      const back = await openPanel(driver);
      back.handleInput(UP);
      back.handleInput(ENTER);

      await vi.waitFor(() => {
        expect(transcriptText(driver)).toContain(`Back in ${project}`);
      });
      const [options] = harness.createSession.mock.calls.at(-1)!;
      expect(options).toMatchObject({ workDir: project, environmentId: 'local' });
      expect(options?.environmentCwd).toBeUndefined();
      expect(driver.state.appState).toMatchObject({ sessionId: 'ses-3', workDir: project, cwd: project, worktree: undefined });
    });

    it('lands in the matching subdirectory of the worktree, or its root when the commit lacks it', async () => {
      const project = tempDir('kimi-location-project-');
      const worktree = tempDir('kimi-location-worktree-');
      mkdirSync(join(project, 'pkg'));
      const driver = await startAt(join(project, 'pkg'), worktreeHarness(project, worktree).harness);
      const enter = async (key: string): Promise<void> => {
        const panel = await openPanel(driver);
        panel.handleInput(key);
        panel.handleInput(ENTER);
        await vi.waitFor(() => {
          expect(slot(driver, WorktreePanelComponent)).toBeUndefined();
        });
      };

      await enter(DOWN);
      await vi.waitFor(() => {
        expect(transcriptText(driver)).toContain("pkg doesn't exist at this commit, so the session starts at the worktree root.");
      });
      expect(driver.state.appState).toMatchObject({ workDir: join(project, 'pkg'), cwd: worktree });

      mkdirSync(join(worktree, 'pkg'));
      await enter(UP);
      await vi.waitFor(() => {
        expect(driver.state.appState.cwd).toBe(join(project, 'pkg'));
      });
      await enter(DOWN);
      await vi.waitFor(() => {
        expect(driver.state.appState.cwd).toBe(join(worktree, 'pkg'));
      });
    });

    it('reports why the panel cannot open', async () => {
      const project = tempDir('kimi-location-project-');
      const outside = worktreeHarness(project, project);
      outside.listWorktrees.mockRejectedValue(
        new KimiError(ErrorCodes.WORKTREE_NOT_GIT_REPO, `${project} is not inside a git repository.`),
      );
      const plain = await startAt(project, outside.harness);
      runCommand(plain, '/worktree');
      await vi.waitFor(() => {
        expect(transcriptText(plain)).toContain(`${project} is not inside a git repository.`);
      });
      expect(slot(plain, WorktreePanelComponent)).toBeUndefined();

      const remoteSession = makeSession({
        getEnvironment: vi.fn(async () => ({ environmentId: 'dev-box', cwd: '/remote/work' })),
      });
      const remote = worktreeHarness(project, project, remoteSession);
      const driver = await startAt(project, remote.harness, { environment: 'dev-box', environmentCwd: '/remote/work' });
      runCommand(driver, '/worktree');
      await vi.waitFor(() => {
        expect(transcriptText(driver)).toContain("Worktrees aren't available for remote environments.");
      });
      expect(remote.listWorktrees).not.toHaveBeenCalled();
    });

    it('deletes a worktree after the user picks what to discard', async () => {
      const project = tempDir('kimi-location-project-');
      const worktree = tempDir('kimi-location-worktree-');
      const { harness, listWorktrees, inspectWorktreeRemoval, removeWorktree } = worktreeHarness(project, worktree);
      inspectWorktreeRemoval.mockResolvedValue(
        removalCheck(worktree, { uncommittedFiles: 2, uniqueCommits: 1, closedSessionCount: 1 }),
      );
      const driver = await startAt(project, harness);
      await driver.ensureSession();
      const panel = await openPanel(driver);
      listWorktrees.mockResolvedValueOnce({ repoRoot: project, worktrees: [] });

      panel.handleInput(DOWN);
      panel.handleInput('d');
      const prompt = await choose(driver, [DOWN, ENTER]);

      expect(prompt).toContain('Delete worktree fix-login?');
      expect(prompt).toContain('2 uncommitted files will be lost.');
      expect(prompt).toContain('1 commit exists only in this worktree.');
      expect(prompt).toContain('1 earlier session worked here. You can still read it, but not continue it.');
      expect(inspectWorktreeRemoval).toHaveBeenCalledWith({
        repoRoot: project,
        path: worktree,
        deleteBranch: false,
        excludeSessionId: 'ses-1',
      });
      await vi.waitFor(() => {
        expect(panelText(driver)).toContain('Deleted fix-login.');
      });
      expect(removeWorktree).toHaveBeenCalledWith({
        repoRoot: project,
        path: worktree,
        deleteBranch: false,
        discard: { uncommittedFiles: 2, uniqueCommits: 1 },
        excludeSessionId: 'ses-1',
      });
      expect(panelText(driver)).not.toContain(basename(worktree));
    });

    it('refuses to delete a worktree that another window has open', async () => {
      const project = tempDir('kimi-location-project-');
      const worktree = tempDir('kimi-location-worktree-');
      const { harness, inspectWorktreeRemoval, removeWorktree } = worktreeHarness(project, worktree);
      inspectWorktreeRemoval.mockResolvedValueOnce(removalCheck(worktree, { openSessionIds: ['ses-9'] }));
      removeWorktree.mockRejectedValue(
        new KimiError(ErrorCodes.WORKTREE_IN_USE, 'The worktree is in use.', {
          details: { path: worktree, openSessionIds: ['ses-9'] },
        }),
      );
      const driver = await startAt(project, harness);
      const panel = await openPanel(driver);

      panel.handleInput(DOWN);
      panel.handleInput('d');
      await vi.waitFor(() => {
        expect(panelText(driver)).toContain('fix-login is open in another Kimi Code window.');
      });
      expect(slot(driver, ChoicePickerComponent)).toBeUndefined();

      panel.handleInput('d');
      await choose(driver, [DOWN, ENTER]);
      await vi.waitFor(() => {
        expect(removeWorktree).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(panelText(driver)).toContain('fix-login is open in another Kimi Code window.');
      });
      expect(panelText(driver)).toContain(basename(worktree));
    });
  });

  describe('leaving a Kimi worktree', () => {
    interface ExitDriver extends LocationDriver {
      handleUserInput(text: string): void;
      readonly worktreeExit: { readonly outcome?: { readonly kind: string } };
      readonly worktreeCreation: {
        readonly createdThisRun: Map<string, { name: string; repoRoot: string; setupScriptRan: boolean }>;
      };
      mountEditorReplacement(panel: Component & Focusable): void;
    }

    async function startInWorktree(removal: { uncommittedFiles: number }) {
      onTestFinished(() => {
        setExperimentalFeatures([]);
      });
      const project = tempDir('kimi-exit-project-');
      const worktree = tempDir('kimi-exit-worktree-');
      const inspectWorktreeRemoval = vi.fn(async () => ({
        path: worktree,
        missing: false,
        branch: undefined,
        uniqueCommits: 0,
        openSessionIds: [],
        closedSessionCount: 0,
        ...removal,
      }));
      const removeWorktree = vi.fn(async (_input: unknown) => {});
      const harness = makeHarness(makeSession({ id: 'ses-new' }), {
        inspectWorktreeRemoval,
        removeWorktree,
        getExperimentalFeatures: vi.fn(async () => [{ id: 'worktree', enabled: true }]),
      });
      const driver = makeDriver(harness, {
        ...makeStartupInput({ model: 'k2' }),
        workDir: project,
        cwd: worktree,
        worktree: { root: worktree, name: 'wt', repoRoot: project },
      }) as ExitDriver;
      await driver.initMainTui();
      const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
      const mount = vi.spyOn(driver, 'mountEditorReplacement');
      return { inspectWorktreeRemoval, removeWorktree, driver, worktree, stop, mount };
    }

    it('asks on /exit, and Ctrl+C in the dialog keeps the worktree and exits', async () => {
      const { removeWorktree, driver, stop, mount } = await startInWorktree({ uncommittedFiles: 1 });

      driver.handleUserInput('/exit');
      await vi.waitFor(() => {
        expect(mount).toHaveBeenCalled();
      });
      const dialog = mount.mock.calls[0]![0];
      expect(stripVTControlCharacters(dialog.render(100).join('\n'))).toContain('Leaving worktree wt');
      expect(stop).not.toHaveBeenCalled();

      dialog.handleInput?.('\u0003');
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledOnce();
      });
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(driver.worktreeExit.outcome?.kind).toBe('kept');
    });

    it('deletes a worktree created this run on /exit when the session /new started there is untouched', async () => {
      const { removeWorktree, driver, worktree, stop, mount } = await startInWorktree({ uncommittedFiles: 0 });
      driver.worktreeCreation.createdThisRun.set(worktree, { name: 'wt', repoRoot: 'unused', setupScriptRan: false });
      await driver.createNewSession();

      driver.handleUserInput('/exit');
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledOnce();
      });
      expect(mount).not.toHaveBeenCalled();
      expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: worktree, excludeSessionId: 'ses-new' }));
      expect(driver.worktreeExit.outcome?.kind).toBe('deleted');
    });

    it('exits on /exit without asking while the worktree flag is off', async () => {
      const { inspectWorktreeRemoval, driver, stop } = await startInWorktree({ uncommittedFiles: 1 });
      setExperimentalFeatures([]);

      driver.handleUserInput('/exit');
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledOnce();
      });
      expect(inspectWorktreeRemoval).not.toHaveBeenCalled();
      expect(driver.worktreeExit.outcome).toBeUndefined();
    });
  });
});
