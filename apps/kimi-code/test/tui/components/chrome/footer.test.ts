import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
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

describe('FooterComponent runtime slot', () => {
  const ERROR = '38;2;232;84;84'; // colors.error #E85454
  let repoDir: string;
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  function plain(text: string): string {
    return text.replaceAll(/\[[0-9;]*m/g, '');
  }

  function line1(footer: FooterComponent, width = 160): string {
    return plain(footer.render(width)[0] ?? '');
  }

  beforeEach(() => {
    // A real repo so the local git slot has a branch to render when visible.
    repoDir = mkdtempSync(join(tmpdir(), 'kimi-footer-runtime-'));
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

  function footerWith(runtime: AppState['runtime']): FooterComponent {
    return new FooterComponent({ ...appState, workDir: repoDir, runtime });
  }

  it('renders no runtime identifier for the local runtime and keeps the git slot', () => {
    const footer = footerWith({ runtimeId: 'local', type: 'local', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).not.toContain('local');
    expect(rendered).toContain('main');
    footer.dispose();
  });

  it('renders no runtime identifier while the runtime state is unsynced', () => {
    const footer = footerWith(undefined);
    const rendered = line1(footer);
    expect(rendered).not.toContain('local');
    expect(rendered).toContain('main');
    footer.dispose();
  });

  it('shows the remote identifier ahead of the cwd', () => {
    const footer = footerWith({ runtimeId: 'dev-box', type: 'ssh', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box');
    expect(rendered.indexOf('dev-box')).toBeLessThan(rendered.indexOf('kimi-footer-runtime'));
    footer.dispose();
  });

  it('renders the bare runtime id with no type prefix, even for command runtimes', () => {
    const footer = footerWith({ runtimeId: 'kimi-dev', type: 'command', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).toContain('kimi-dev');
    expect(rendered).not.toContain('command:kimi-dev');
    expect(rendered).not.toContain('command:');
    footer.dispose();
  });

  it('hides the local git slot for a remote-bound session', () => {
    const footer = footerWith({ runtimeId: 'dev-box', type: 'ssh', status: 'ready' });
    const rendered = line1(footer);
    expect(rendered).toContain('dev-box');
    expect(rendered).not.toContain('main');
    footer.dispose();
  });

  it('renders a disconnected remote identifier in the error color', () => {
    const footer = footerWith({ runtimeId: 'dev-box', type: 'ssh', status: 'disconnected' });
    const rendered = footer.render(160)[0] ?? '';
    expect(rendered).toContain('dev-box');
    expect(rendered).toContain(ERROR);
    footer.dispose();
  });

  it('appends the disconnect reason to a disconnected remote identifier', () => {
    const footer = footerWith({
      runtimeId: 'dev-box',
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
      runtimeId: 'dev-box',
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
});
