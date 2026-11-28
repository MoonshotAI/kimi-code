import { stripVTControlCharacters } from 'node:util';

import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;

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

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

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

  it('shows the remote environment cwd instead of the local work directory', () => {
    const lines = new WelcomeComponent({
      ...appState,
      workDir: '/Users/local/project',
      environment: {
        environmentId: 'remote-env',
        type: 'ssh',
        status: 'ready',
        cwd: '/home/remote/project',
      },
    }).render(80);

    expect(lines.some((line) => line.includes('/home/remote/project'))).toBe(true);
    expect(lines.some((line) => line.includes('/Users/local/project'))).toBe(false);
  });

  it('adds a Worktree line under Directory only inside a worktree', () => {
    vi.stubEnv('HOME', '/Users/me');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const text = (state: AppState) =>
      new WelcomeComponent(state)
        .render(120)
        .map((line) => stripVTControlCharacters(line).replaceAll(/^│\s*|\s*│$/g, ''));
    const worktreeRoot = '/Users/me/.kimi-code/worktrees/wd_project/fix-login';
    const inside = text({
      ...appState,
      workDir: worktreeRoot,
      projectRoot: '/Users/me/code/project',
      isGitRepo: true,
      worktree: { root: worktreeRoot, name: 'fix-login', repoRoot: '/Users/me/code/project' },
    });
    const directory = inside.findIndex((line) => line.startsWith('Directory: '));
    expect(inside[directory]).toBe(`Directory: ${worktreeRoot}`);
    expect(inside[directory + 1]).toBe('Worktree:  fix-login of ~/code/project');
    expect(inside[directory + 2]).toMatch(/^Session: {3}/);

    const outside = text({ ...appState, workDir: '/Users/me/code/project' });
    expect(outside.some((line) => line.startsWith('Worktree:'))).toBe(false);
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
