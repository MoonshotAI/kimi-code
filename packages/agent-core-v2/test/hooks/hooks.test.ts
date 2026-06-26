import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IConfigService } from '#/config/config';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { HookEngine } from '#/hooks/hookEngine';
import { ILogService } from '#/log/log';

describe('HookEngine', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, { _serviceBrand: undefined });
    ix.stub(ILogService, { _serviceBrand: undefined });
  });
  afterEach(() => disposables.dispose());

  it('passes through with continue: true by default', async () => {
    const hooks = disposables.add(ix.createInstance(HookEngine));
    expect(await hooks.runUserPromptSubmit('hi')).toEqual({ continue: true });
    expect(await hooks.runPreToolCall('bash', {})).toEqual({ continue: true });
    await expect(hooks.runSessionStart()).resolves.toBeUndefined();
  });
});
