import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
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
  thinking: false,
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

  it('renders no quota rows when quotas are unset', () => {
    const footer = new FooterComponent(appState);
    expect(footer.render(80).length).toBe(2);
  });

  it('renders managed quota rows in aligned columns with reset hint', () => {
    const state: AppState = {
      ...appState,
      contextUsage: 0.5,
      contextTokens: 1_000,
      maxContextTokens: 2_000,
      quotas: [
        { label: 'Weekly limit', used: 41, limit: 100, resetHint: 'resets in 5d 3h' },
        { label: '5H LIMIT', used: 65, limit: 100, resetHint: 'resets in 1h 3m' },
      ],
    };
    const footer = new FooterComponent(state);
    const lines = footer.render(200);

    expect(lines.length).toBe(4);
    const contextLine = stripAnsi(lines[1]!);
    const weekLine = stripAnsi(lines[2]!);
    const hourLine = stripAnsi(lines[3]!);

    expect(contextLine.trimStart().startsWith('context:')).toBe(true);
    expect(weekLine.trimStart().startsWith('week:')).toBe(true);
    expect(hourLine.trimStart().startsWith('5h:')).toBe(true);
    expect(contextLine).toMatch(/context:\s+50\.0%\s+\(1\.0k\/2\.0k\)/);
    expect(weekLine).toMatch(/week\s*:\s+41\.0%\s+\(5d, 3h\)/);
    expect(hourLine).toMatch(/5h\s*:\s+65\.0%\s+\(1h, 3m\)/);

    // Colons, percentages and suffixes share the same columns.
    const colonIdx = contextLine.indexOf(':');
    expect(weekLine.indexOf(':')).toBe(colonIdx);
    expect(hourLine.indexOf(':')).toBe(colonIdx);
    expect(weekLine.indexOf('41.0%')).toBe(hourLine.indexOf('65.0%'));
    expect(weekLine.indexOf('(5d, 3h)')).toBe(hourLine.indexOf('(1h, 3m)'));

    // All rows share the same visible width (right-aligned block).
    expect(stripAnsi(contextLine).length).toBe(stripAnsi(weekLine).length);
    expect(stripAnsi(weekLine).length).toBe(stripAnsi(hourLine).length);
  });

  it('lowercases quota labels and colors the percentage', () => {
    const state: AppState = {
      ...appState,
      contextUsage: 0,
      contextTokens: 1_000_000,
      maxContextTokens: 2_000_000,
      quotas: [{ label: '5H LIMIT', used: 50, limit: 100, resetHint: 'reset' }],
    };
    const footer = new FooterComponent(state);
    const lines = footer.render(120);
    const quotaLine = lines[2]!;

    expect(stripAnsi(quotaLine).trimStart().startsWith('5h:')).toBe(true);
    expect(stripAnsi(quotaLine)).toMatch(/5h\s*:\s+50\.0%\s+\(reset\)/);
    expect(truecolorCodes(quotaLine).size).toBeGreaterThan(0);
  });

  it('reserves column width for 100.0 % so the block does not shift', () => {
    const state: AppState = {
      ...appState,
      contextUsage: 0,
      quotas: [
        { label: 'week', used: 44.6, limit: 100, resetHint: 'resets in 5d 3h' },
        { label: '5h', used: 100, limit: 100, resetHint: 'resets in 2h 13m' },
      ],
    };
    const footer = new FooterComponent(state);
    const lines = footer.render(200);
    const weekLine = stripAnsi(lines[2]!);
    const fullLine = stripAnsi(lines[3]!);

    expect(weekLine).toMatch(/week\s*:\s+44\.6%\s+\(5d, 3h\)/);
    expect(fullLine).toMatch(/5h\s*:\s+100\.0%\s+\(2h, 13m\)/);
    // The right edge of the percentage column should align.
    expect(weekLine.indexOf('%')).toBe(fullLine.indexOf('%'));
  });
});
