import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { i18n } from '#/tui/i18n';
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
  language: 'auto',
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

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('WelcomeComponent — locale rendering', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    i18n.setLocale('en');
  });

  it('renders the welcome title in Simplified Chinese under zh-CN', () => {
    i18n.setLocale('zh-CN');

    const output = new WelcomeComponent(appState).render(80).map(strip).join('\n');

    expect(output).toContain('欢迎使用 Kimi Code');
    expect(output).not.toContain('Welcome to Kimi Code');
  });

  it('shows the help hint in Chinese when logged in', () => {
    i18n.setLocale('zh-CN');

    const output = new WelcomeComponent(appState).render(80).map(strip).join('\n');

    expect(output).toContain('发送 /help 获取帮助信息');
    expect(output).not.toContain('Send /help for help information');
  });

  it('shows the login hint and unset-model notice in Chinese when logged out', () => {
    i18n.setLocale('zh-CN');
    const loggedOut: AppState = { ...appState, model: '' };

    const output = new WelcomeComponent(loggedOut).render(80).map(strip).join('\n');

    expect(output).toContain('运行 /login 或 /provider 开始使用');
    expect(output).toContain('未设置');
    expect(output).not.toContain('Run /login or /provider to get started');
    expect(output).not.toContain('not set, run /login or /provider');
  });

  it('renders the info field labels in Chinese while keeping values verbatim', () => {
    i18n.setLocale('zh-CN');
    const withMcp: AppState = { ...appState, mcpServersSummary: '2 servers' };

    const output = new WelcomeComponent(withMcp).render(80).map(strip).join('\n');

    expect(output).toContain('目录');
    expect(output).toContain('会话');
    expect(output).toContain('模型');
    expect(output).toContain('版本');
    // Values are not translated.
    expect(output).toContain('/tmp/project');
    expect(output).toContain('ses-1');
    expect(output).toContain('1.2.3');
    expect(output).toContain('2 servers');
    // The MCP key stays as the acronym.
    expect(output).toContain('MCP');
    expect(output).not.toContain('Directory');
    expect(output).not.toContain('Version');
  });

  it('renders the welcome surface in English on the default locale', () => {
    const withMcp: AppState = { ...appState, mcpServersSummary: '2 servers' };

    const output = new WelcomeComponent(withMcp).render(80).map(strip).join('\n');

    expect(output).toContain('Welcome to Kimi Code');
    expect(output).toContain('Send /help for help information.');
    expect(output).toContain('Directory');
    expect(output).toContain('Version');
    expect(output).not.toContain('欢迎');
    expect(output).not.toContain('目录');
  });

  it('keeps every line within the requested width under zh-CN', () => {
    i18n.setLocale('zh-CN');
    const withMcp: AppState = { ...appState, mcpServersSummary: '2 servers' };

    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(withMcp).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
