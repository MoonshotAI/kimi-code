import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ITelemetryService } from '#/telemetry/telemetry';
import { ITurnContext } from '#/turn/turn';

import { ToolDedupService } from '#/tooldedup/tooldedupService';

describe('ToolDedupService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ITelemetryService, {});
    ix.stub(ITurnContext, {});
  });
  afterEach(() => disposables.dispose());

  it('detects same-step duplicates', () => {
    const d = disposables.add(ix.createInstance(ToolDedupService));
    expect(d.checkSameStep('c1', { a: 1 })).toBe(false);
    expect(d.checkSameStep('c1', { a: 1 })).toBe(true);
    expect(d.checkSameStep('c1', { a: 2 })).toBe(false);
    d.dispose();
  });

  it('tracks cross-step streak via finalize', () => {
    const d = disposables.add(ix.createInstance(ToolDedupService));
    d.finalize('same');
    d.finalize('same');
    d.finalize('same');
    expect(d.currentStreak).toBe(3);
    d.finalize('other');
    expect(d.currentStreak).toBe(1);
    d.dispose();
  });
});
