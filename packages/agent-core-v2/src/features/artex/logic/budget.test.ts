import { describe, expect, it } from 'vitest';

import {
  ARTEX_BUDGET_UNLIMITED,
  ArtexBudgetLedger,
  artexBudgetWrapupBlocks,
  effectiveBudget,
  newArtexBudget,
  wrapupMargin,
  type ArtexBudgetLedger as LedgerType,
} from './budget';

function spend(ledger: LedgerType, n: number): void {
  ledger.record({ inputTokens: n, outputTokens: 0 });
}

function finishWorker(ledger: LedgerType, n: number): void {
  const meter = ledger.startIntent();
  meter.record({ inputTokens: 0, outputTokens: n });
  meter.finish();
}

describe('effectiveBudget', () => {
  it('never exceeds the parent remaining', () => {
    expect(effectiveBudget(newArtexBudget(50, 5), newArtexBudget(100, 10))).toEqual({
      tokens: 50,
      turns: 5,
    });
    expect(effectiveBudget(newArtexBudget(200, 20), newArtexBudget(100, 10))).toEqual({
      tokens: 100,
      turns: 10,
    });
    expect(effectiveBudget(newArtexBudget(0, 0), newArtexBudget(100, 10))).toEqual({
      tokens: 100,
      turns: 10,
    });
    expect(effectiveBudget(newArtexBudget(70, 7), newArtexBudget(0, 0))).toEqual({
      tokens: 70,
      turns: 7,
    });
    expect(effectiveBudget(newArtexBudget(0, 0), newArtexBudget(0, 0))).toEqual({
      tokens: ARTEX_BUDGET_UNLIMITED,
      turns: ARTEX_BUDGET_UNLIMITED,
    });
    expect(effectiveBudget(newArtexBudget(70, 7), { tokens: 0, turns: 0 })).toEqual({
      tokens: 0,
      turns: 0,
    });
  });

  it('clamps an intent meter to the task remaining above the reserve', () => {
    const ledger = ArtexBudgetLedger.create(newArtexBudget(100_000, 0), newArtexBudget(100_000, 5))!;
    spend(ledger, 70_000);
    const meter = ledger.startIntent();
    expect(meter.remaining()).toEqual({ tokens: 10_000, turns: 5 });
    meter.record({ inputTokens: 10_000, outputTokens: 0 });
    expect(meter.exhausted()).toBe(true);
  });
});

describe('wrapupMargin', () => {
  it('reserves 5% then the floors', () => {
    expect(wrapupMargin(newArtexBudget(1_000_000, 100))).toEqual({ tokens: 50_000, turns: 5 });
    expect(wrapupMargin(newArtexBudget(100_000, 10))).toEqual({ tokens: 20_000, turns: 2 });
  });
});

describe('ArtexBudgetLedger dispatch gating', () => {
  it('triggers the wrap-up once and stops dispatch at the reserve', () => {
    const ledger = ArtexBudgetLedger.create(newArtexBudget(100_000, 0), newArtexBudget(0, 0))!;
    finishWorker(ledger, 10);
    spend(ledger, 100_000 - 10 - 20_001);
    let st = ledger.state();
    expect(st.atMargin).toBe(false);
    expect(st.dispatch).toBe(true);
    spend(ledger, 1);
    st = ledger.state();
    expect(st.atMargin).toBe(true);
    expect(st.dispatch).toBe(false);

    const running = ledger.startIntent();
    let wrapups = 0;
    for (let i = 0; i < 3; i++) {
      if (ledger.beginWrapup()) wrapups++;
    }
    expect(wrapups).toBe(1);
    expect(ledger.state().dispatch).toBe(false);
    expect(running.exhausted()).toBe(true);
    expect(artexBudgetWrapupBlocks('Bash')).toBe(true);
    expect(artexBudgetWrapupBlocks('record_fact')).toBe(false);
  });

  it('stops dispatch under one worker estimate (default then averaged)', () => {
    let ledger = ArtexBudgetLedger.create(newArtexBudget(200_000, 0), newArtexBudget(0, 0))!;
    spend(ledger, 200_000 - 50_000);
    expect(ledger.state().dispatch).toBe(true);
    spend(ledger, 1);
    expect(ledger.state().dispatch).toBe(false);
    expect(ledger.state().atMargin).toBe(false);

    ledger = ArtexBudgetLedger.create(newArtexBudget(300_000, 0), newArtexBudget(0, 0))!;
    finishWorker(ledger, 90_000);
    finishWorker(ledger, 30_000);
    spend(ledger, 120_000);
    const st = ledger.state();
    expect(st.estimate.tokens).toBe(60_000);
    expect(st.dispatch).toBe(true);
    spend(ledger, 1);
    expect(ledger.state().dispatch).toBe(false);
  });
});

describe('ArtexBudgetLedger.create', () => {
  it('returns undefined when no budget is set', () => {
    expect(ArtexBudgetLedger.create(newArtexBudget(0, 0), newArtexBudget(0, 0))).toBeUndefined();
  });

  it('counts input+output tokens and folds the per-worker average', () => {
    const ledger = ArtexBudgetLedger.create(newArtexBudget(1_000_000, 1_000), newArtexBudget(0, 0))!;
    for (const u of [
      { inputTokens: 12_000, outputTokens: 800 },
      { inputTokens: 15_500, outputTokens: 1_200 },
    ]) {
      ledger.record(u);
    }
    const meter = ledger.startIntent();
    for (const u of [
      { inputTokens: 4_000, outputTokens: 300 },
      { inputTokens: 6_100, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 0 },
    ]) {
      meter.record(u);
    }
    meter.finish();
    const want = 12_000 + 800 + 15_500 + 1_200 + 4_000 + 300 + 6_100;
    const st = ledger.state();
    expect(st.spent).toEqual({ tokens: want, turns: 5 });
    expect(st.remaining).toEqual({ tokens: 1_000_000 - want, turns: 995 });
    expect(st.estimate).toEqual({ tokens: 10_400, turns: 3 });
  });
});
