import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
} from '#/tui/constant/rendering';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

// Dark dance colors the footer never uses outside of /dance.
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
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

describe('FooterComponent', () => {
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

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
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
      // Reads currentTheme live, so a palette swap changes the emitted colours.
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
    // Same left-hand slots without the tips: measures the space the hint competes for.
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
  const ERROR = '38;2;232;84;84'; // colors.error #E85454
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
    // A real repo so the local git slot has a branch to render when visible.
    repoDir = mkdtempSync(join(tmpdir(), 'kimi-footer-environment-'));
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    spawnSync('git', ['add', '.'], { cwd: repoDir });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
      cwd: repoDir,
    });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  function footerWith(environment: AppState['environment']): FooterComponent {
    return new FooterComponent({ ...appState, workDir: repoDir, environment });
  }

  it('renders no environment identifier for the local environment and keeps the git slot', () => {
    const footer = footerWith({ environmentId: 'local', type: 'local', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).not.toContain('local');
    expect(rendered).toContain('main');
    footer.dispose();
  });

  it('renders no environment identifier while the environment state is unsynced', () => {
    const footer = footerWith(undefined);
    const rendered = line1(footer);
    expect(rendered).not.toContain('local');
    expect(rendered).toContain('main');
    footer.dispose();
  });

  it('shows the remote identifier ahead of the cwd', () => {
    const footer = footerWith({ environmentId: 'dev-box', type: 'ssh', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box');
    expect(rendered.indexOf('dev-box')).toBeLessThan(rendered.indexOf('kimi-footer-environment'));
    footer.dispose();
  });

  it('renders the bare environment id with no type prefix, even for command environments', () => {
    const footer = footerWith({ environmentId: 'kimi-dev', type: 'command', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).toContain('kimi-dev');
    expect(rendered).not.toContain('command:kimi-dev');
    expect(rendered).not.toContain('command:');
    footer.dispose();
  });

  it('hides the local git slot for a remote-bound session', () => {
    const footer = footerWith({ environmentId: 'dev-box', type: 'ssh', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box');
    expect(rendered).not.toContain('main');
    footer.dispose();
  });

  describe('status line command payload', () => {
    async function payloadOf(footer: FooterComponent): Promise<{ gitBranch: string | null }> {
      footer.render(400);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const line = plain(footer.render(400)[0] ?? '');
      return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)) as { gitBranch: string | null };
    }

    it('feeds gitBranch null to the status line command for a remote-bound session', async () => {
      const footer = new FooterComponent({
        ...appState,
        workDir: repoDir,
        environment: { environmentId: 'dev-box', type: 'ssh', status: 'ready' },
        statusLine: { items: null, command: 'cat' },
      });
      const payload = await payloadOf(footer);
      expect(payload.gitBranch).toBeNull();
      footer.dispose();
    });

    it('feeds the local branch to the status line command for a local session', async () => {
      const footer = new FooterComponent({
        ...appState,
        workDir: repoDir,
        environment: { environmentId: 'local', type: 'local', status: 'ready' },
        statusLine: { items: null, command: 'cat' },
      });
      const payload = await payloadOf(footer);
      expect(payload.gitBranch).toBe('main');
      footer.dispose();
    });
  });

  it('renders a disconnected remote identifier in the error color', () => {
    const footer = footerWith({ environmentId: 'dev-box', type: 'ssh', status: 'disconnected' });
    const rendered = footer.render(160)[0] ?? '';
    expect(rendered).toContain('dev-box');
    expect(rendered).toContain(ERROR);
    footer.dispose();
  });

  it('appends the disconnect reason to a disconnected remote identifier', () => {
    const footer = footerWith({
      environmentId: 'dev-box',
      type: 'ssh',
      status: 'disconnected',
      connectError: 'ssh: connect failed',
    });
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box (ssh: connect failed)');
    footer.dispose();
  });

  it('bounds the disconnect reason to its first line and a fixed width', () => {
    const footer = footerWith({
      environmentId: 'dev-box',
      type: 'ssh',
      status: 'disconnected',
      connectError: 'ssh: connect failed with a very long reason that keeps going\nretry guidance must not render',
    });
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box (');
    expect(rendered).toContain('…');
    expect(rendered).not.toContain('retry guidance');
    footer.dispose();
  });

  it('shows the binding cwd instead of the local workDir for a remote-bound session', () => {
    const footer = footerWith({
      environmentId: 'dev-box',
      type: 'ssh',
      status: 'ready',
      cwd: '/home/deploy/app',
    });
    const rendered = line1(footer);
    expect(rendered).toContain('/home/deploy/app');
    expect(rendered).not.toContain('kimi-footer-environment');
    footer.dispose();
  });

  it('never claims ~ for a remote cwd that happens to sit under the local home', () => {
    const home = process.env['HOME'] ?? '';
    const footer = new FooterComponent({
      ...appState,
      workDir: repoDir,
      statusLine: { items: ['environment', 'cwd'], command: null },
      environment: { environmentId: 'dev-box', type: 'ssh', status: 'ready', cwd: `${home}/remote-project` },
    });
    const rendered = line1(footer);
    expect(rendered).toContain('remote-project');
    expect(rendered).not.toContain('~');
    footer.dispose();
  });

  it('shortens a deep remote cwd by segments without a home claim', () => {
    const footer = footerWith({
      environmentId: 'dev-box',
      type: 'ssh',
      status: 'ready',
      cwd: '/home/deploy/very/deep/nested/project',
    });
    const rendered = line1(footer);
    expect(rendered).toContain('…/deep/nested/project');
    expect(rendered).not.toContain('~');
    footer.dispose();
  });

  it('keeps shortening the local workDir against the local home', () => {
    const home = process.env['HOME'] ?? '';
    const footer = new FooterComponent({ ...appState, workDir: `${home}/local-project` });
    const rendered = line1(footer);
    expect(rendered).toContain('~/local-project');
    footer.dispose();
  });

  it('renders a spinner frame beside the identifier while connecting', () => {
    const footer = footerWith({ environmentId: 'dev-box', type: 'ssh', status: 'connecting' });
    const rendered = line1(footer);
    expect(rendered).toContain(`${BRAILLE_SPINNER_FRAMES[0] ?? ''} dev-box`);
    footer.dispose();
  });

  it('ticks the spinner through frames on the shared interval while connecting', () => {
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
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 2);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(line1(footer)).toContain(`${BRAILLE_SPINNER_FRAMES[2] ?? ''} dev-box`);
    footer.dispose();
  });

  it('starts the spinner when the environment enters connecting', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const footer = new FooterComponent(
      {
        ...appState,
        workDir: repoDir,
        environment: { environmentId: 'dev-box', type: 'ssh', status: 'ready' },
      },
      onRefresh,
    );
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
    expect(onRefresh).not.toHaveBeenCalled();
    footer.setState({
      ...appState,
      workDir: repoDir,
      environment: { environmentId: 'dev-box', type: 'ssh', status: 'connecting' },
    });
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    footer.dispose();
  });

  it('stops the spinner the moment the environment leaves connecting', () => {
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
    footer.setState({
      ...appState,
      workDir: repoDir,
      environment: { environmentId: 'dev-box', type: 'ssh', status: 'ready' },
    });
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
    expect(onRefresh).not.toHaveBeenCalled();
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box');
    for (const frame of BRAILLE_SPINNER_FRAMES) {
      expect(rendered).not.toContain(frame);
    }
    footer.dispose();
  });

  it('starts no spinner for the local environment even while connecting', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const footer = new FooterComponent(
      {
        ...appState,
        workDir: repoDir,
        environment: { environmentId: 'local', type: 'local', status: 'connecting' },
      },
      onRefresh,
    );
    expect(line1(footer)).not.toContain('local');
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
    expect(onRefresh).not.toHaveBeenCalled();
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
