import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  showSessionTitleInFooter: false,
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
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
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

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_PATTERN, '');
}

describe('FooterComponent session title', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('hides the session title when the toggle is off', () => {
    const state: AppState = {
      ...appState,
      sessionTitle: 'My session',
      showSessionTitleInFooter: false,
    };
    const footer = new FooterComponent(state);

    expect(stripAnsi(footer.render(120).join('\n'))).not.toContain('My session');
  });

  it('shows the session title after the git badge when the toggle is on', () => {
    const state: AppState = {
      ...appState,
      sessionTitle: 'My session',
      showSessionTitleInFooter: true,
    };
    const footer = new FooterComponent(state);

    const rendered = stripAnsi(footer.render(120).join('\n'));
    expect(rendered).toContain('My session');
    // Line 1 joins items with two spaces: cwd, then title (no git repo here).
    const line1 = rendered.split('\n')[0] ?? '';
    const cwdIndex = line1.indexOf('/tmp/project');
    const titleIndex = line1.indexOf('My session');
    expect(cwdIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeGreaterThan(cwdIndex);
  });

  it('renders no empty segment when the toggle is on but the title is null', () => {
    const withToggle: AppState = {
      ...appState,
      sessionTitle: null,
      showSessionTitleInFooter: true,
    };
    const withoutToggle: AppState = {
      ...appState,
      sessionTitle: null,
      showSessionTitleInFooter: false,
    };

    expect(new FooterComponent(withToggle).render(120).join('\n')).toBe(
      new FooterComponent(withoutToggle).render(120).join('\n'),
    );
  });

  it('renders the title right after the git branch badge', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'kimi-footer-title-'));
    try {
      execFileSync('git', ['init', '-b', 'trunk', repoDir]);
      const state: AppState = {
        ...appState,
        workDir: repoDir,
        sessionTitle: 'My session',
        showSessionTitleInFooter: true,
      };
      const footer = new FooterComponent(state);

      const line1 = stripAnsi(footer.render(160).join('\n')).split('\n')[0] ?? '';
      const branchIndex = line1.indexOf('trunk');
      const titleIndex = line1.indexOf('My session');
      expect(branchIndex).toBeGreaterThanOrEqual(0);
      expect(titleIndex).toBeGreaterThan(branchIndex);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('renders a title of exactly 40 columns without an ellipsis', () => {
    const state: AppState = {
      ...appState,
      sessionTitle: 'a'.repeat(40),
      showSessionTitleInFooter: true,
    };
    const footer = new FooterComponent(state);

    const rendered = stripAnsi(footer.render(200).join('\n'));
    expect(rendered).toContain('a'.repeat(40));
    expect(rendered).not.toContain('…');
  });

  it('truncates a 41-column title to width 40 with an ellipsis', () => {
    const state: AppState = {
      ...appState,
      sessionTitle: 'a'.repeat(41),
      showSessionTitleInFooter: true,
    };
    const footer = new FooterComponent(state);

    const rendered = stripAnsi(footer.render(200).join('\n'));
    // Width-aware: 39 columns of text + the 1-column ellipsis.
    expect(rendered).toContain(`${'a'.repeat(39)}…`);
    expect(rendered).not.toContain('a'.repeat(40));
  });

  it('caps wide titles by display width, not character count', () => {
    const state: AppState = {
      ...appState,
      sessionTitle: 'a'.repeat(50),
      showSessionTitleInFooter: true,
    };
    const footer = new FooterComponent(state);

    const rendered = stripAnsi(footer.render(200).join('\n'));
    expect(rendered).toContain(`${'a'.repeat(39)}…`);
    expect(rendered).not.toContain('a'.repeat(40));
  });

  it('caps CJK titles by display width (2 columns per character)', () => {
    const state: AppState = {
      ...appState,
      // 25 CJK characters = 50 columns, over the 40-column cap.
      sessionTitle: '汉'.repeat(25),
      showSessionTitleInFooter: true,
    };
    const footer = new FooterComponent(state);

    const rendered = stripAnsi(footer.render(200).join('\n'));
    // 19 CJK chars (38 columns) + the 1-column ellipsis = 39 columns.
    expect(rendered).toContain(`${'汉'.repeat(19)}…`);
    expect(rendered).not.toContain('汉'.repeat(20));
  });
});
