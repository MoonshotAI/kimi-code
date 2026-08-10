import type { AuthManagedUsageResult, ParsedManagedUsage } from '@moonshot-ai/kimi-code-oauth';
import { describe, expect, it, vi } from 'vitest';

import { ManagedUsageController } from '#/tui/controllers/managed-usage';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/tui/constant/kimi-tui';

const USAGE: ParsedManagedUsage = {
  summary: { window: { duration: 1, unit: 'week' }, used: 20, limit: 100 },
  limits: [{ window: { duration: 5, unit: 'hour' }, used: 10, limit: 100 }],
  extraUsage: null,
};

function okResult(): AuthManagedUsageResult {
  return {
    kind: 'ok',
    summary: USAGE.summary,
    limits: USAGE.limits,
    extraUsage: USAGE.extraUsage,
  };
}

describe('ManagedUsageController', () => {
  it('caches successful reads for the TTL and supports a forced refresh', async () => {
    let now = 1_000;
    const load = vi.fn(async () => okResult());
    const update = vi.fn();
    const controller = new ManagedUsageController(
      { currentProvider: () => DEFAULT_OAUTH_PROVIDER_NAME, load, update },
      { now: () => now, cacheTtlMs: 60_000 },
    );

    await controller.refresh();
    now += 30_000;
    await controller.refresh();
    await controller.refresh({ force: true });

    expect(load).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(USAGE);
  });

  it('coalesces concurrent reads for the same provider', async () => {
    let resolve!: (result: AuthManagedUsageResult) => void;
    const load = vi.fn(
      () => new Promise<AuthManagedUsageResult>((done) => { resolve = done; }),
    );
    const controller = new ManagedUsageController({
      currentProvider: () => DEFAULT_OAUTH_PROVIDER_NAME,
      load,
      update: vi.fn(),
    });

    const first = controller.refresh();
    const second = controller.refresh({ force: true });
    resolve(okResult());

    await expect(first).resolves.toEqual({ usage: USAGE });
    await expect(second).resolves.toEqual({ usage: USAGE });
    expect(load).toHaveBeenCalledOnce();
  });

  it('clears quota data after a failed refresh', async () => {
    const load = vi.fn(async () => ({ kind: 'error' as const, message: 'unauthorized', status: 401 }));
    const update = vi.fn();
    const controller = new ManagedUsageController({
      currentProvider: () => DEFAULT_OAUTH_PROVIDER_NAME,
      load,
      update,
    });

    await expect(controller.refresh()).resolves.toEqual({ error: 'unauthorized' });
    await expect(controller.refresh()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(null);
  });

  it('drops a managed-provider response that lands after a provider switch', async () => {
    let provider = DEFAULT_OAUTH_PROVIDER_NAME;
    let resolve!: (result: AuthManagedUsageResult) => void;
    const update = vi.fn();
    const controller = new ManagedUsageController({
      currentProvider: () => provider,
      load: () => new Promise<AuthManagedUsageResult>((done) => { resolve = done; }),
      update,
    });

    const pending = controller.refresh();
    provider = 'openai';
    controller.syncProvider();
    resolve(okResult());
    await pending;

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(null);
  });
});
