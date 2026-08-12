import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  SECONDARY_MODEL_SECTION,
  SUBAGENT_SECTION,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import { ISessionSubagentModelsValidationService } from '#/session/subagent/subagentModelsValidation';
import { SessionSubagentModelsValidationService } from '#/session/subagent/subagentModelsValidationService';

import { StubConfigService } from '../../kosong/stubs';
import { stubFlag } from '../../app/flag/stubs';

describe('SessionSubagentModelsValidationService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let modelIds: Set<string>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    modelIds = new Set();
  });
  afterEach(() => {
    disposables.dispose();
  });

  function setup(configValues: Record<string, unknown>, flagEnabled = true): void {
    ix.stub(IConfigService, new StubConfigService(configValues));
    ix.stub(IFlagService, stubFlag((id) => flagEnabled && id === SECONDARY_MODEL_FLAG_ID));
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (id: string) => {
        if (!modelIds.has(id)) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `Model "${id}" is not configured in config.toml.`,
            { details: { model: id } },
          );
        }
        return { id } as Model;
      },
    } as unknown as IModelCatalog);
    ix.set(
      ISessionSubagentModelsValidationService,
      new SyncDescriptor(SessionSubagentModelsValidationService),
    );
  }

  function resolve(): unknown {
    try {
      ix.get(ISessionSubagentModelsValidationService);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('is a no-op when no secondary_model section is configured', () => {
    setup({});
    expect(resolve()).toBeUndefined();
  });

  it('is a no-op when only the [subagent] timeout is configured', () => {
    setup({ [SUBAGENT_SECTION]: { timeoutMs: 5000 } });
    expect(resolve()).toBeUndefined();
  });

  it('is a no-op for a broken pool while the secondary-model experiment is off', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/typo' } }, false);
    expect(resolve()).toBeUndefined();
  });

  it('constructs fine when default_model alone forms an implicit single-entry pool', () => {
    modelIds.add('provider/fast');
    setup({ [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/fast' } });
    expect(resolve()).toBeUndefined();
  });

  it('constructs fine when the legacy model key alone forms the fallback pool', () => {
    modelIds.add('provider/fast');
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/fast' } });
    expect(resolve()).toBeUndefined();
  });

  it('fails session creation when the legacy model fallback does not resolve', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' } });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model.models] entry "provider/typo" could not be resolved',
    );
  });

  it('constructs fine when force pins the legacy model fallback', () => {
    modelIds.add('provider/fast');
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/fast', force: true } });
    expect(resolve()).toBeUndefined();
  });

  it('fails session creation when a pool table relies on the legacy model key for its default', () => {
    modelIds.add('provider/fast');
    setup({
      [SECONDARY_MODEL_SECTION]: {
        model: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
      },
    });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model].default_model is required when [secondary_model.models] is configured',
    );
  });

  it('fails session creation when a pool-less default_model does not resolve', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/typo' } });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model.models] entry "provider/typo" could not be resolved',
    );
  });

  it('constructs fine for a valid pool', () => {
    modelIds.add('provider/fast').add('provider/smart');
    setup({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
      },
    });
    expect(resolve()).toBeUndefined();
  });

  it('fails session creation when the pool has no default_model', () => {
    modelIds.add('provider/fast');
    setup({ [SECONDARY_MODEL_SECTION]: { models: { 'provider/fast': 'fast and cheap' } } });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model].default_model is required when [secondary_model.models] is configured',
    );
  });

  it('fails session creation when default_model is not a pool key, listing the pool', () => {
    modelIds.add('provider/fast').add('provider/smart');
    setup({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/typo',
        models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
      },
    });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain('"provider/typo"');
    expect((error as Error2).message).toContain(
      'Available models: provider/fast, provider/smart.',
    );
  });

  it('fails session creation when a pool key uses the reserved "primary" alias', () => {
    modelIds.add('primary').add('provider/fast');
    setup({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { primary: 'looks like a model', 'provider/fast': 'fast and cheap' },
      },
    });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model.models] key "primary" is reserved',
    );
  });

  it('fails session creation when a pool key does not resolve, naming the key', () => {
    modelIds.add('provider/fast');
    setup({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap', 'provider/typo': 'hard tasks' },
      },
    });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model.models] entry "provider/typo" could not be resolved',
    );
    expect((error as Error2).message).toContain('"provider/typo" is not configured');
    expect(isError2((error as Error2).cause)).toBe(true);
  });

  it('constructs fine when force pins a resolvable default_model', () => {
    modelIds.add('provider/fast');
    setup({ [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/fast', force: true } });
    expect(resolve()).toBeUndefined();
  });

  it('fails session creation when force is set without default_model', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { force: true } });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model].default_model is required when [secondary_model].force is set',
    );
  });

  it('fails session creation when force is combined with a models table', () => {
    modelIds.add('provider/fast');
    setup({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
        force: true,
      },
    });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[secondary_model].force cannot be combined with [secondary_model.models]',
    );
  });

  it('fails session creation when the forced default_model does not resolve', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/typo', force: true } });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain('"provider/typo"');
  });
});
