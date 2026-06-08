import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
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
  inputMode: 'agent',
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
    const footer = new FooterComponent(appState, darkColors);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState, darkColors);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('renders the [shell] badge when inputMode is shell', () => {
    const shellState = { ...appState, inputMode: 'shell' as const };
    const footer = new FooterComponent(shellState, darkColors);
    const lines = footer.render(120);
    expect(lines[0]).toContain('shell');
  });

  it('does not render the [shell] badge when inputMode is agent', () => {
    const agentState = { ...appState, inputMode: 'agent' as const };
    const footer = new FooterComponent(agentState, darkColors);
    const lines = footer.render(120);
    expect(lines[0]).not.toContain('shell');
  });
});
