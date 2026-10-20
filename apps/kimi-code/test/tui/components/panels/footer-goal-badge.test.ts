import { afterEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
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

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship it',
    status: 'active',
    turnsUsed: 7,
    tokensUsed: 1234,
    wallClockMs: 245_000, // 4m05s
    budget: {
      turnBudget: null,
      tokenBudget: null,
      wallClockBudgetMs: null,
    },
    ...overrides,
  } as GoalSnapshot;
}

describe('FooterComponent — goal badge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits the badge when there is no goal', () => {
    const footer = new FooterComponent(baseState({ goal: null }));
    expect(strip(footer.render(160)[0]!)).not.toContain('[goal');
  });

  it('shows status, elapsed, and a raw turn count for an unbounded active goal', () => {
    const footer = new FooterComponent(baseState({ goal: goal() }));
    const out = strip(footer.render(160)[0]!);
    expect(out).toContain('[goal');
    expect(out).toContain('active');
    expect(out).toContain('4m');
    expect(out).toContain('7 turns');
    // No N/M when no turn budget is set.
    expect(out).not.toMatch(/\d+\/\d+ turns/);
  });

  it('keeps counting elapsed time for an active goal between snapshots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const footer = new FooterComponent(
      baseState({ goal: goal({ wallClockMs: 0, turnsUsed: 0 }) }),
    );

    expect(strip(footer.render(160)[0]!)).toContain('0s');
    vi.setSystemTime(2_500);
    expect(strip(footer.render(160)[0]!)).toContain('3s');
  });

  it('requests a repaint while an active goal timer is visible', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();

    new FooterComponent(baseState({ goal: goal({ wallClockMs: 0 }) }), onRefresh);

    vi.advanceTimersByTime(1_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows used/limit turns only when a turn budget is set', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ budget: { turnBudget: 20, tokenBudget: null, wallClockBudgetMs: null } } as Partial<GoalSnapshot>) }),
    );
    expect(strip(footer.render(160)[0]!)).toContain('7/20 turns');
  });

  it('shows a paused badge', () => {
    const footer = new FooterComponent(baseState({ goal: goal({ status: 'paused' }) }));
    expect(strip(footer.render(160)[0]!)).toContain('paused');
  });

  it('shows a blocked badge (resumable, still present)', () => {
    const footer = new FooterComponent(baseState({ goal: goal({ status: 'blocked' }) }));
    const out = strip(footer.render(160)[0]!);
    expect(out).toContain('[goal');
    expect(out).toContain('blocked');
  });

  it('hides the badge for a completed goal', () => {
    const footer = new FooterComponent(baseState({ goal: goal({ status: 'complete' }) }));
    expect(strip(footer.render(160)[0]!)).not.toContain('[goal');
  });

  it('singularizes a single turn', () => {
    const footer = new FooterComponent(baseState({ goal: goal({ turnsUsed: 1 }) }));
    const out = strip(footer.render(160)[0]!);
    expect(out).toContain('1 turn');
    expect(out).not.toContain('1 turns');
  });
});
