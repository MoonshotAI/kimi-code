import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { buildWeightedTips, FooterComponent } from '#/tui/components/chrome/footer';
import { ALL_TIPS, TRANSCRIPT_GROUPING_TIP } from '#/tui/constant/tips';
import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { AppState } from '#/tui/types';

const gitStatusMocks = vi.hoisted(() => ({
  createGitStatusCache: vi.fn(),
}));

vi.mock('#/utils/git/git-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/git/git-status')>();
  return { ...actual, createGitStatusCache: gitStatusMocks.createGitStatusCache };
});

beforeEach(() => {
  gitStatusMocks.createGitStatusCache.mockClear();
  gitStatusMocks.createGitStatusCache.mockImplementation(() => ({
    getStatus: vi.fn(() => null),
    refresh: vi.fn(),
    dispose: vi.fn(),
  }));
});

const gitSource = {
  status: async () => null,
  pullRequest: async () => null,
};

function plainText(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

const RAINBOW_CYAN = '91,192,190';
const RAINBOW_GREEN = '78,200,126';

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  stepRetry: null,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  towerMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

describe('FooterComponent', () => {
  it('asks the git cache to refresh and disposes it with the footer', () => {
    const refresh = vi.fn();
    const dispose = vi.fn();
    gitStatusMocks.createGitStatusCache.mockImplementation(() => ({
      getStatus: () => null,
      refresh,
      dispose,
    }));
    const footer = new FooterComponent(appState);
    footer.refreshGitStatus();
    expect(gitStatusMocks.createGitStatusCache).not.toHaveBeenCalled();
    footer.setGitBinding((state) => ({ key: state.sessionId, source: gitSource }));
    footer.refreshGitStatus();
    expect(refresh).toHaveBeenCalledTimes(1);
    footer.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the git cache through a disconnect and refreshes it once the environment is ready again', () => {
    const refresh = vi.fn();
    const dispose = vi.fn();
    gitStatusMocks.createGitStatusCache.mockImplementation(() => ({ getStatus: () => null, refresh, dispose }));
    const remote = (status: 'ready' | 'disconnected'): AppState => ({
      ...appState,
      environment: { environmentId: 'dev-box', type: 'ssh', status },
    });
    const footer = new FooterComponent(remote('ready'));
    footer.setGitBinding((state) => ({ key: state.sessionId, source: gitSource }));

    footer.setState(remote('disconnected'));
    expect(dispose).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    footer.setState(remote('ready'));
    expect(refresh).toHaveBeenCalledTimes(1);
    footer.setState(remote('ready'));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(gitStatusMocks.createGitStatusCache).toHaveBeenCalledTimes(1);
    footer.dispose();
  });

  it('keeps the git cache for the same binding key and replaces it on a new one', () => {
    const dispose = vi.fn();
    gitStatusMocks.createGitStatusCache.mockImplementation(() => ({
      getStatus: () => ({
        branch: 'main',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
      refresh: vi.fn(),
      dispose,
    }));
    const footer = new FooterComponent(appState);
    footer.setGitBinding((state) => (state.sessionId === 'none' ? null : { key: state.sessionId, source: gitSource }));
    expect(plainText(footer.render(160)[0] ?? '')).toContain('main');

    footer.setState({ ...appState, model: 'other' });
    expect(gitStatusMocks.createGitStatusCache).toHaveBeenCalledTimes(1);

    footer.setState({ ...appState, sessionId: 'ses-2' });
    expect(gitStatusMocks.createGitStatusCache).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);

    footer.setState({ ...appState, sessionId: 'none' });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(plainText(footer.render(160)[0] ?? '')).not.toContain('main');
    footer.dispose();
  });

  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('paints the model name in rainbow while colored', () => {
    setDanceView(true, 0);
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('repaints from the active palette on the next render (no setColors needed)', () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join('\n');
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it('shows the effort for an effort-capable model', () => {
    const effortModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'max',
      availableModels: { 'kimi-k2': effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: max');
  });

  it('does not show the effort for a legacy boolean model', () => {
    const plainModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      capabilities: ['thinking'],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join('\n');

    expect(rendered).toContain('thinking');
    expect(rendered).not.toContain('thinking:high');
  });

  it('shows the tower mode chip only when tower mode is on', () => {
    const on = new FooterComponent({ ...appState, towerMode: true });
    expect(on.render(120).join('\n')).toContain('tower');

    const off = new FooterComponent(appState);
    expect(off.render(120).join('\n')).not.toContain('tower');
  });
});

describe('FooterComponent overrides', () => {
  it('shows the overridden effort list', () => {
    const effortModelWithOverride: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: high');
  });
});

describe('FooterComponent displayName override', () => {
  it('renders the overridden display name', () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('Custom Name');
    expect(footer.render(120).join('\n')).not.toContain('Remote Name');
  });
});

describe('FooterComponent line-2 hints', () => {
  function stripAnsi(text: string): string {
    return text.replaceAll(/\[[0-9;]*m/g, '');
  }

  it('shows the warning hint on line 2', () => {
    const footer = new FooterComponent(appState);
    footer.setWarningHint('Goal objective is too long');

    const line2 = stripAnsi(footer.render(120)[1] ?? '');

    expect(line2).toContain('Goal objective is too long');
  });

  it('gives the transient hint precedence, then restores the warning hint', () => {
    const footer = new FooterComponent(appState);
    footer.setWarningHint('Goal objective is too long');

    footer.setTransientHint('Press Ctrl+C again to exit');
    expect(stripAnsi(footer.render(120)[1] ?? '')).toContain('Press Ctrl+C again to exit');
    expect(stripAnsi(footer.render(120)[1] ?? '')).not.toContain('Goal objective is too long');

    footer.setTransientHint(null);
    expect(stripAnsi(footer.render(120)[1] ?? '')).toContain('Goal objective is too long');
  });

  it('clears the warning hint with null', () => {
    const footer = new FooterComponent(appState);
    footer.setWarningHint('Goal objective is too long');
    footer.setWarningHint(null);

    expect(stripAnsi(footer.render(120)[1] ?? '')).not.toContain('Goal objective is too long');
  });
});

describe('FooterComponent ctrl+o hint', () => {
  function plain(text: string): string {
    return text.replaceAll(/\[[0-9;]*m/g, '');
  }
  function line1(footer: FooterComponent, width = 160): string {
    return plain(footer.render(width)[0] ?? '');
  }

  it('shows no hint while there is no tool output to toggle', () => {
    const footer = new FooterComponent(appState);
    footer.setExpandHintProvider(() => null);
    expect(line1(footer)).not.toContain('ctrl+o');
    footer.dispose();
  });

  it('offers expand while collapsed output exists and collapse once it is shown', () => {
    const footer = new FooterComponent(appState);
    let hint: 'expand' | 'collapse' | null = 'expand';
    footer.setExpandHintProvider(() => hint);
    expect(line1(footer)).toContain('ctrl+o expand');
    hint = 'collapse';
    expect(line1(footer)).toContain('ctrl+o collapse');
    footer.dispose();
  });

  it('keeps the hint and drops the rotating tip when only one of them fits', () => {
    const noTips = new FooterComponent({
      ...appState,
      statusLine: { items: ['mode', 'model', 'cwd'], command: null },
    });
    const leftWidth = plain(noTips.render(200)[0] ?? '').trimEnd().length;
    noTips.dispose();

    const footer = new FooterComponent(appState);
    footer.setExpandHintProvider(() => 'expand');
    const narrow = line1(footer, leftWidth + 2 + 'ctrl+o expand'.length);
    expect(narrow.endsWith('ctrl+o expand')).toBe(true);
    expect(narrow).not.toContain(' | ');
    footer.dispose();
  });
});

describe('FooterComponent ctrl+o hint with a status_line command', () => {
  it('moves the hint to line 2 when a command owns line 1', async () => {
    const footer = new FooterComponent({
      ...appState,
      statusLine: { items: null, command: 'printf "my-custom-status"' },
    });
    footer.setExpandHintProvider(() => 'expand');
    footer.render(120);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [line1, line2] = footer.render(120).map((line) => line.replaceAll(/\[[0-9;]*m/g, ''));
    expect(line1).toContain('my-custom-status');
    expect(line1).not.toContain('ctrl+o');
    expect(line2).toContain('ctrl+o expand');
    expect(line2).toContain('context:');
    footer.dispose();
  });
});

describe('transcript grouping tip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appears only when the running fullscreen UI has settings that create groups', () => {
    const rotation = buildWeightedTips([...ALL_TIPS, TRANSCRIPT_GROUPING_TIP]);
    const index = rotation.findIndex((tip) => tip.text === TRANSCRIPT_GROUPING_TIP.text);
    expect(index).toBeGreaterThanOrEqual(0);
    vi.setSystemTime(index * 10_000);

    const fullscreenFooter = (state: AppState) => new FooterComponent(state, undefined, true);
    const fullscreenState = { ...appState, tuiMode: 'fullscreen' as const };
    const grouping = fullscreenFooter(fullscreenState);
    expect(grouping.render(240)[0]).toContain(TRANSCRIPT_GROUPING_TIP.text);
    grouping.dispose();

    const toolGroups = fullscreenFooter({
      ...fullscreenState,
      transcript: { toolCallDensity: 'detailed', thinking: 'ungrouped' },
    });
    expect(toolGroups.render(240)[0]).toContain(TRANSCRIPT_GROUPING_TIP.text);
    toolGroups.dispose();

    const noGroups = fullscreenFooter({
      ...fullscreenState,
      transcript: { toolCallDensity: 'ungrouped', thinking: 'ungrouped' },
    });
    expect(noGroups.render(240)[0]).not.toContain(TRANSCRIPT_GROUPING_TIP.text);
    noGroups.dispose();

    const thoughtGroups = fullscreenFooter({
      ...fullscreenState,
      transcript: { toolCallDensity: 'ungrouped', thinking: 'grouped' },
    });
    expect(thoughtGroups.render(240)[0]).toContain(TRANSCRIPT_GROUPING_TIP.text);
    thoughtGroups.dispose();

    const regularMode = new FooterComponent({ ...appState, tuiMode: 'regular' });
    expect(regularMode.render(240)[0]).not.toContain(TRANSCRIPT_GROUPING_TIP.text);
    regularMode.dispose();

    const switchedToFullscreen = new FooterComponent({ ...appState, tuiMode: 'regular' });
    switchedToFullscreen.setState({ ...appState, tuiMode: 'fullscreen' });
    expect(switchedToFullscreen.render(240)[0]).not.toContain(TRANSCRIPT_GROUPING_TIP.text);
    switchedToFullscreen.dispose();

    const switchedToRegular = fullscreenFooter(fullscreenState);
    switchedToRegular.setState({ ...fullscreenState, tuiMode: 'regular' });
    expect(switchedToRegular.render(240)[0]).toContain(TRANSCRIPT_GROUPING_TIP.text);
    switchedToRegular.dispose();
  });
});

describe('FooterComponent ctrl+o hint beside an inline tips slot', () => {
  function plain(text: string): string {
    return text.replaceAll(/\[[0-9;]*m/g, '');
  }

  it('drops the inline tip when the hint would not fit beside it', () => {
    const noTips = new FooterComponent({
      ...appState,
      statusLine: { items: ['mode', 'model', 'cwd'], command: null },
    });
    const leftWidth = plain(noTips.render(200)[0] ?? '').trimEnd().length;
    noTips.dispose();

    const footer = new FooterComponent({
      ...appState,
      statusLine: { items: ['mode', 'tips', 'model', 'cwd'], command: null },
    });
    footer.setExpandHintProvider(() => 'expand');
    const width = leftWidth + 2 + 'ctrl+o expand'.length;
    const line1 = plain(footer.render(width)[0] ?? '');
    expect(line1.endsWith('ctrl+o expand')).toBe(true);
    expect(line1.length).toBeLessThanOrEqual(width);
    footer.dispose();
  });
});

describe('FooterComponent environment slot', () => {
  const ERROR = '38;2;232;84;84';
  let repoDir: string;
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    vi.useRealTimers();
  });

  function plain(text: string): string {
    return text.replaceAll(/\[[0-9;]*m/g, '');
  }

  function line1(footer: FooterComponent, width = 160): string {
    return plain(footer.render(width)[0] ?? '');
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'kimi-footer-environment-'));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  function footerWith(environment: AppState['environment']): FooterComponent {
    return new FooterComponent({ ...appState, workDir: repoDir, environment });
  }

  it('renders the remote identifier ahead of the cwd without a type prefix', () => {
    const ssh = footerWith({ environmentId: 'dev-box', type: 'ssh', status: 'ready' });
    const sshRendered = line1(ssh);
    expect(sshRendered).toContain('dev-box');
    expect(sshRendered.indexOf('dev-box')).toBeLessThan(sshRendered.indexOf('kimi-footer-environment'));
    ssh.dispose();

    const command = footerWith({ environmentId: 'kimi-dev', type: 'command', status: 'ready' });
    const commandRendered = line1(command);
    expect(commandRendered).toContain('kimi-dev');
    expect(commandRendered).not.toContain('command:kimi-dev');
    expect(commandRendered).not.toContain('command:');
    command.dispose();
  });

  it('renders a disconnected remote identifier in the error color', () => {
    const footer = footerWith({ environmentId: 'dev-box', type: 'ssh', status: 'disconnected' });
    const rendered = footer.render(160)[0] ?? '';
    expect(rendered).toContain('dev-box');
    expect(rendered).toContain(ERROR);
    footer.dispose();
  });

  it('leaves no spinner timer running after dispose', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const footer = new FooterComponent(
      {
        ...appState,
        workDir: repoDir,
        environment: { environmentId: 'dev-box', type: 'ssh', status: 'connecting' },
      },
      onRefresh,
    );
    footer.dispose();
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('FooterComponent worktree location', () => {
  const worktree = { root: '/tmp/wt/fix-login', name: 'fix-login', repoRoot: '/tmp/project' };
  const statusOn = (branch: string) => ({
    branch,
    dirty: true,
    ahead: 0,
    behind: 0,
    diffAdded: 3,
    diffDeleted: 1,
    pullRequest: null,
  });
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  function footerAt(state: Partial<AppState>, branch: string | null): FooterComponent {
    gitStatusMocks.createGitStatusCache.mockImplementation(() => ({
      getStatus: () => (branch === null ? null : statusOn(branch)),
      refresh: vi.fn(),
      dispose: vi.fn(),
    }));
    const footer = new FooterComponent({ ...appState, ...state });
    footer.setGitBinding((current) => ({ key: current.workDir, source: gitSource }));
    onTestFinished(() => {
      footer.dispose();
    });
    return footer;
  }

  it('names the worktree in the cwd slot and marks a detached HEAD', () => {
    const footer = footerAt({ workDir: worktree.root, worktree }, '');
    const rendered = footer.render(160)[0] ?? '';
    expect(stripVTControlCharacters(rendered)).toContain('worktree fix-login  detached [+3 -1]');
    expect(rendered).toContain(chalk.hex(darkColors.accent)('fix-login'));
    expect(stripVTControlCharacters(rendered)).not.toContain('/tmp/wt');
  });

  it('appends the path below the worktree root including dot-prefixed subdirectories', () => {
    const footer = footerAt({ workDir: `${worktree.root}/packages/foo`, worktree }, 'feat/login');
    expect(stripVTControlCharacters(footer.render(160)[0] ?? '')).toContain(
      'worktree fix-login/packages/foo  feat/login [+3 -1]',
    );

    const dotdot = footerAt({ workDir: `${worktree.root}/..cache`, worktree }, 'feat/login');
    expect(stripVTControlCharacters(dotdot.render(160)[0] ?? '')).toContain(
      'worktree fix-login/..cache  feat/login [+3 -1]',
    );
  });

  it('keeps the plain cwd and hides a detached HEAD outside a worktree', () => {
    const footer = footerAt({ workDir: '/tmp/project' }, '');
    const rendered = stripVTControlCharacters(footer.render(160)[0] ?? '');
    expect(rendered).toContain('/tmp/project');
    expect(rendered).not.toContain('worktree');
    expect(rendered).not.toContain('detached');
  });

  it('shows the remote cwd while a remote environment is bound', () => {
    const footer = footerAt(
      {
        workDir: worktree.root,
        worktree,
        environment: { environmentId: 'dev-box', type: 'ssh', status: 'ready', cwd: '/remote/work' },
      },
      'main',
    );
    const rendered = stripVTControlCharacters(footer.render(160)[0] ?? '');
    expect(rendered).toContain('/remote/work');
    expect(rendered).not.toContain('worktree fix-login');
  });
});

describe('FooterComponent spinning transient hints', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('animates a spinning transient hint and stops ticking when cleared or replaced', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const footer = new FooterComponent(appState, onRefresh);
    onTestFinished(() => {
      footer.dispose();
    });

    footer.setTransientHint('Shutting down… (running shutdown hooks)', { spinning: true });
    expect(footer.getTransientHint()).toBe('Shutting down… (running shutdown hooks)');
    expect(stripVTControlCharacters(footer.render(140)[1] ?? '')).toContain(
      `${BRAILLE_SPINNER_FRAMES[0]} Shutting down… (running shutdown hooks)`,
    );

    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(stripVTControlCharacters(footer.render(140)[1] ?? '')).toContain(
      `${BRAILLE_SPINNER_FRAMES[1]} Shutting down… (running shutdown hooks)`,
    );

    footer.setTransientHint('Deleting worktree wt… (Ctrl+C to force quit)', { spinning: true });
    expect(stripVTControlCharacters(footer.render(140)[1] ?? '')).toContain(
      `${BRAILLE_SPINNER_FRAMES[1]} Deleting worktree wt… (Ctrl+C to force quit)`,
    );

    footer.setTransientHint('Press Ctrl+C again to exit');
    onRefresh.mockClear();
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 3);
    expect(onRefresh).not.toHaveBeenCalled();
    const staticLine = stripVTControlCharacters(footer.render(140)[1] ?? '');
    expect(staticLine).toContain('Press Ctrl+C again to exit');
    expect(staticLine).not.toContain(BRAILLE_SPINNER_FRAMES[0]);

    footer.setTransientHint('Shutting down…', { spinning: true });
    footer.setTransientHint(null);
    onRefresh.mockClear();
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 3);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(footer.getTransientHint()).toBeNull();
  });

  it('stops the transient hint spinner timer on dispose', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const footer = new FooterComponent(appState, onRefresh);
    footer.setTransientHint('Deleting worktree wt… (Ctrl+C to force quit)', { spinning: true });
    footer.dispose();
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('FooterComponent workspace plan badge', () => {
  const managedModel: ModelAlias = {
    provider: 'managed:kimi-code',
    model: 'kimi-k2',
    maxContextSize: 200_000,
    displayName: 'Kimi K2',
  };

  const customModel: ModelAlias = {
    provider: 'openai',
    model: 'gpt-5',
    maxContextSize: 200_000,
    displayName: 'GPT-5',
  };

  it('displays the plan badge only for managed Kimi Code models when the user has a business workspace', () => {
    const enterpriseFooter = new FooterComponent({
      ...appState,
      model: 'kimi-k2',
      availableModels: { 'kimi-k2': managedModel },
      managedWorkspace: {
        hasBusinessWorkspace: true,
        statusWorkspaceLine: 'Alice · Acme',
        planLabel: 'Premium',
      },
    });
    expect(plainText(enterpriseFooter.render(160)[0] ?? '')).toContain('Kimi K2  Premium');
    enterpriseFooter.dispose();

    const personalFooter = new FooterComponent({
      ...appState,
      model: 'kimi-k2',
      availableModels: { 'kimi-k2': managedModel },
      managedWorkspace: {
        hasBusinessWorkspace: false,
      },
    });
    expect(plainText(personalFooter.render(160)[0] ?? '')).not.toContain('Premium');
    personalFooter.dispose();

    const customProviderFooter = new FooterComponent({
      ...appState,
      model: 'gpt-5',
      availableModels: { 'gpt-5': customModel },
      managedWorkspace: {
        hasBusinessWorkspace: true,
        planLabel: 'Premium',
      },
    });
    expect(plainText(customProviderFooter.render(160)[0] ?? '')).not.toContain('Premium');
    customProviderFooter.dispose();
  });
});
