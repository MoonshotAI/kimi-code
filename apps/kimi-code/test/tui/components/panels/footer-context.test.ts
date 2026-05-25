import { describe, it, expect } from 'vitest';
import chalk from 'chalk';

import { FooterComponent, formatFooterGitBadge } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp',
    sessionId: 'sess_1',
    yolo: false,
    permissionMode: 'manual',
    planMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    outputTokensPerSecond: null,
    isStreaming: false,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

describe('FooterComponent — context NaN resilience', () => {
  it('NaN usage → renders 0.0% (never literal "NaN%")', () => {
    const fc = new FooterComponent(baseState({ contextUsage: Number.NaN }), darkColors);
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });

  it('undefined-ish (coerced) usage → renders 0.0%', () => {
    const fc = new FooterComponent(
      baseState({ contextUsage: undefined as unknown as number }),
      darkColors,
    );
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });

  it('clamps ratios above 1.0 → renders 100.0%', () => {
    const fc = new FooterComponent(baseState({ contextUsage: 1.5 }), darkColors);
    const out = strip(fc.render(120).join(''));
    expect(out).toMatch(/context: 100\.0%/);
  });

  it('ratio 0.427 → renders 42.7%', () => {
    const fc = new FooterComponent(baseState({ contextUsage: 0.427 }), darkColors);
    const out = strip(fc.render(200).join(''));
    expect(out).toMatch(/context: 42\.7%/);
  });

  it('tokens provided but max=0 → falls back to percent-only, no division-by-zero artefact', () => {
    const fc = new FooterComponent(
      baseState({ contextUsage: 0, contextTokens: 500, maxContextTokens: 0 }),
      darkColors,
    );
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/Infinity|NaN/);
    expect(out).toMatch(/context: 0\.0%/);
    // With maxTokens=0, token-count annotation is suppressed.
    expect(out).not.toMatch(/\(500\//);
  });

  it('setState updates visible model and context values', () => {
    const footer = new FooterComponent(baseState({ model: 'k2', contextUsage: 0 }), darkColors);

    footer.setState(baseState({ model: 'kimi-k2-5', contextUsage: 0.5 }));

    const out = strip(footer.render(200).join(''));
    expect(out).toContain('kimi-k2-5');
    expect(out).not.toContain(' k2 ');
    expect(out).toMatch(/context: 50\.0%/);
  });

  it('shows "thinking" label when thinking is enabled, hides it when disabled', () => {
    const on = new FooterComponent(baseState({ model: 'k2', thinking: true }), darkColors);
    const off = new FooterComponent(baseState({ model: 'k2', thinking: false }), darkColors);

    expect(strip(on.render(120)[0]!)).toContain('thinking');
    expect(strip(off.render(120)[0]!)).not.toContain('thinking');
  });

  it('renders transient hints on the context line', () => {
    const footer = new FooterComponent(baseState(), darkColors);

    footer.setTransientHint('Press Ctrl-C again to exit');

    const [, line2] = footer.render(120);
    expect(strip(line2 ?? '')).toContain('Press Ctrl-C again to exit');
    expect(strip(line2 ?? '')).toContain('context: 0.0%');
  });

  it('renders recent output token throughput on the context line', () => {
    const footer = new FooterComponent(
      baseState({ outputTokensPerSecond: 24.62, contextUsage: 0.125 }),
      darkColors,
    );

    const [, line2] = footer.render(120);
    expect(strip(line2 ?? '')).toContain('speed: 24.6 tok/s');
    expect(strip(line2 ?? '')).toContain('context: 12.5%');
  });

  it('lets transient hints temporarily replace token throughput', () => {
    const footer = new FooterComponent(baseState({ outputTokensPerSecond: 24.62 }), darkColors);

    footer.setTransientHint('Press Ctrl-C again to exit');

    const [, line2] = footer.render(120);
    expect(strip(line2 ?? '')).toContain('Press Ctrl-C again to exit');
    expect(strip(line2 ?? '')).not.toContain('tok/s');
  });

  it('highlights the pull request badge separately from git status text', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const out = formatFooterGitBadge(
        {
          branch: 'feature/footer',
          dirty: false,
          ahead: 0,
          behind: 0,
          diffAdded: 0,
          diffDeleted: 0,
          pullRequest: {
            number: 6,
            url: 'https://github.com/acme/repo/pull/6',
          },
        },
        darkColors,
      );

      const primaryIndex = out.indexOf(hexToSgr(darkColors.primary));
      const statusIndex = out.indexOf(hexToSgr(darkColors.status));
      const badgeIndex = out.indexOf('[PR#6]');
      expect(statusIndex).toBeGreaterThanOrEqual(0);
      expect(primaryIndex).toBeGreaterThanOrEqual(0);
      expect(primaryIndex).toBeLessThan(badgeIndex);
      expect(strip(out)).toContain('feature/footer ');
      expect(strip(out)).toContain('[PR#6]');
    } finally {
      chalk.level = previousLevel;
    }
  });
});
