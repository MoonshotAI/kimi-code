import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { CompactionService } from '#/compaction/compactionService';
import { IContextService } from '#/context/context';
import { ContextService } from '#/context/contextService';
import { IInjectionService } from '#/injection/injection';
import { InjectionService } from '#/injection/injectionService';
import { ITurnService } from '#/turn/turn';
import { registerConfigServices } from '../config/stubs';
import { registerRecordsServices } from '../records/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';
import { registerTurnServices } from '../turn/stubs';

describe('CompactionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerRecordsServices,
        registerConfigServices,
        registerTelemetryServices,
        registerTurnServices,
      ],
      additionalServices: (reg) => {
        reg.define(IContextService, ContextService);
        reg.define(IInjectionService, InjectionService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  // NOTE: CompactionService is built via createInstance (not get) because each
  // test needs a different token threshold — a static argument the container
  // cannot bake into a singleton. See di-testing.md "Exceptions".
  it('injects a compaction summary when token usage exceeds the threshold', async () => {
    const ctx = ix.get(IContextService);
    ctx.appendMessage({ role: 'user', content: 'x'.repeat(100) });
    const injection = ix.get(IInjectionService);
    ix.createInstance(CompactionService, 10);
    const turn = ix.get(ITurnService);
    await turn.prompt('go');
    expect(injection.flush()).toEqual([
      { kind: 'compaction_summary', content: 'context overflow — compact pending' },
    ]);
  });

  it('does nothing below the threshold', async () => {
    const ctx = ix.get(IContextService);
    ctx.appendMessage({ role: 'user', content: 'hi' });
    const injection = ix.get(IInjectionService);
    ix.createInstance(CompactionService, 10_000);
    const turn = ix.get(ITurnService);
    await turn.prompt('go');
    expect(injection.flush()).toEqual([]);
  });
});
