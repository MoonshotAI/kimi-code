import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IHookEngine } from '#/hooks/hooks';
import { HookEngine } from '#/hooks/hookEngine';
import { registerConfigServices } from '../config/stubs';
import { registerLogServices } from '../log/stubs';

describe('HookEngine', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerConfigServices, registerLogServices],
      additionalServices: (reg) => {
        reg.define(IHookEngine, HookEngine);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('passes through with continue: true by default', async () => {
    const hooks = ix.get(IHookEngine);
    expect(await hooks.runUserPromptSubmit('hi')).toEqual({ continue: true });
    expect(await hooks.runPreToolCall('bash', {})).toEqual({ continue: true });
    await expect(hooks.runSessionStart()).resolves.toBeUndefined();
  });
});
