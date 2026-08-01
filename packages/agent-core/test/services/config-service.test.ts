import { describe, expect, it, vi } from 'vitest';

import type { CoreRPC, KimiConfig, KimiConfigPatch } from '../../src';
import {
  ConfigService,
  type ICoreProcessService,
  type IEventService,
} from '../../src/services';

describe('ConfigService', () => {
  it('round-trips secondary-model priority through the v1 config contract', async () => {
    let config: KimiConfig = { providers: {} };
    const setKimiConfig = vi.fn(async (patch: KimiConfigPatch) => {
      config = { ...config, secondaryModel: patch.secondaryModel };
      return config;
    });
    const core = {
      _serviceBrand: undefined,
      rpc: {
        getKimiConfig: vi.fn(async () => config),
        setKimiConfig,
      } as unknown as CoreRPC,
      ready: async () => undefined,
      dispose: () => undefined,
    } satisfies ICoreProcessService;
    const events = {
      _serviceBrand: undefined,
      onDidPublish: () => ({ dispose: () => undefined }),
      publish: vi.fn(),
    } satisfies IEventService;
    const service = new ConfigService(core, events);

    const updated = await service.set({
      secondary_model: { default_effort: 'low', priority: true },
    });

    expect(setKimiConfig).toHaveBeenCalledWith({
      secondaryModel: { defaultEffort: 'low', priority: true },
    });
    expect(updated.secondary_model).toEqual({ default_effort: 'low', priority: true });
    await expect(service.get()).resolves.toMatchObject({
      secondary_model: { default_effort: 'low', priority: true },
    });
  });
});
