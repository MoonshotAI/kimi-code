import { describe, it, expect } from 'vitest';
import chalk from 'chalk';

import { FooterComponent, formatFooterGitBadge, buildWeightedTips } from '#/tui/components/chrome/footer';
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
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
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
    const fc = new FooterComponent(baseState({ contextUsage: Number.NaN }));
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });

  it('undefined-ish (coerced) usage → renders 0.0%', () => {
    const fc = new FooterComponent(
      baseState({ contextUsage: undefined as unknown as number }),
    );
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });

  it('clamps ratios above 1.0 → renders 100.0%', () => {
    const fc = new FooterComponent(baseState({ contextUsage: 1.5 }));
    const out = strip(fc.render(120).join(''));
    expect(out).toMatch(/context: 100\.0%/);
  });

  it('ratio 0.427 → renders 42.7%', () => {
    const fc = new FooterComponent(baseState({ contextUsage: 0.427 }));
    const out = strip(fc.render(200).join(''));
    expect(out).toMatch(/context: 42\.7%/);
  });

  it('tokens provided but max=0 → falls back to percent-only, no division-by-zero artefact', () => {
    const fc = new FooterComponent(
      baseState({ contextUsage: 0, contextTokens: 500, maxContextTokens: 0 }),
    );
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/Infinity|NaN/);
    expect(out).toMatch(/context: 0\.0%/);
    // With maxTokens=0, token-count annotation is suppressed.
    expect(out).not.toMatch(/\(500\//);
  });

  it('setState updates visible model and context values', () => {
    const footer = new FooterComponent(baseState({ model: 'k2', contextUsage: 0 }));

    footer.setState(baseState({ model: 'kimi-k2-5', contextUsage: 0.5 }));

    const out = strip(footer.render(200).join(''));
    expect(out).toContain('kimi-k2-5');
    expect(out).not.toContain(' k2 ');
    expect(out).toMatch(/context: 50\.0%/);
  });

  it('shows "thinking" label when thinking is enabled, hides it when disabled', () => {
    const on = new FooterComponent(baseState({ model: 'k2', thinkingEffort: 'on' }));
    const off = new FooterComponent(baseState({ model: 'k2', thinkingEffort: 'off' }));

    expect(strip(on.render(120)[0]!)).toContain('thinking');
    expect(strip(off.render(120)[0]!)).not.toContain('thinking');
  });

  it('renders transient hints on the context line', () => {
    const footer = new FooterComponent(baseState());

    footer.setTransientHint('Press Ctrl-C again to exit');

    const [, line2] = footer.render(120);
    expect(strip(line2 ?? '')).toContain('Press Ctrl-C again to exit');
    expect(strip(line2 ?? '')).toContain('context: 0.0%');
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
      const statusIndex = out.indexOf(hexToSgr(darkColors.textDim));
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

describe('buildWeightedTips — weighted rotation', () => {
  it('repeats higher-priority tips more often (length = sum of weights)', () => {
    const seq = buildWeightedTips([
      { text: 'a' }, // weight 1 (default)
      { text: 'b', priority: 3 },
      { text: 'c', priority: 2 },
    ]);

    const count = (t: string) => seq.filter((x) => x.text === t).length;
    expect(seq).toHaveLength(6);
    expect(count('a')).toBe(1);
    expect(count('b')).toBe(3);
    expect(count('c')).toBe(2);
    expect(count('b')).toBeGreaterThan(count('a'));
  });

  it('keeps duplicates spread out — no tip sits next to itself', () => {
    const seq = buildWeightedTips([
      { text: 'a' },
      { text: 'b', priority: 3 },
      { text: 'c', priority: 2 },
    ]);

    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!.text).not.toBe(seq[i - 1]!.text);
    }
  });

  it('preserves array order when all weights are the default (1)', () => {
    const seq = buildWeightedTips([{ text: 'x' }, { text: 'y' }, { text: 'z' }]);
    expect(seq.map((t) => t.text)).toEqual(['x', 'y', 'z']);
  });

  it('clamps non-positive / fractional priorities to a weight of at least 1', () => {
    const seq = buildWeightedTips([
      { text: 'a', priority: 0 },
      { text: 'b', priority: -5 },
      { text: 'c', priority: 1.9 },
    ]);
    expect(seq).toHaveLength(3);
    expect(seq.map((t) => t.text).toSorted()).toEqual(['a', 'b', 'c']);
  });
});
