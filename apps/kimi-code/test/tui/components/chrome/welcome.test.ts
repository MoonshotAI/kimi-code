import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinking: false,
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

function stripSgr(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

/** The two header rows (logo + title) of the rendered welcome box. */
function headerOf(lines: string[]): string {
  return [lines[3], lines[4]].join('\n');
}

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

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('renders the banner in a single brand color by default', () => {
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    // No rainbow by default — just the brand primary (plus the dim tagline).
    expect(codes.size).toBeLessThanOrEqual(2);
  });

  it('paints the banner in rainbow while colored', () => {
    setDanceView(true, 0);
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    expect(codes.size).toBeGreaterThanOrEqual(5);
  });

  it('renders exactly the default banner when not colored', () => {
    const base = headerOf(new WelcomeComponent(appState).render(80));
    setDanceView(false, 5);
    const off = headerOf(new WelcomeComponent(appState).render(80));

    expect(off).toBe(base);
  });

  it('shows setup guidance when no models are configured', () => {
    const output = stripSgr(
      new WelcomeComponent({
        ...appState,
        model: '',
        availableModels: {},
      })
        .render(120)
        .join('\n'),
    );

    expect(output).toContain('Run /login or /provider to get started.');
    expect(output).toContain('Model:     not set, run /login or /provider');
  });

  it('shows an unselected model state when models are configured', () => {
    const output = stripSgr(
      new WelcomeComponent({
        ...appState,
        model: '',
        sessionId: '',
        availableModels: {
          'kimi-code/k2': {
            provider: 'kimi-code',
            model: 'kimi-k2',
            maxContextSize: 128000,
            displayName: 'Kimi K2',
          },
        },
      })
        .render(120)
        .join('\n'),
    );

    expect(output).toContain('Pick a session or send /model to choose one.');
    expect(output).toContain('Model:     not selected');
    expect(output).not.toContain('run /login');
  });
});
