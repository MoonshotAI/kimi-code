import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiWebApi } from '@moonshot-ai/app-core/api';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { modelSwitchConfirmStore } from '../src/stores/modelSwitchConfirm';

const CLOUD_CONFIG = {
  enable: true,
  rules: [{ from: 'kimi-k2.5', to: 'kimi-k2-turbo-preview', hint: { en: 'Cache lost.', zh: '缓存失效。' } }],
};

function stubApi(impl: (name: string) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const getClientConfig = vi.fn(impl);
  setKimiClientDeps({
    api: () => ({ getClientConfig }) as unknown as KimiWebApi,
    t: (key) => key,
  });
  return getClientConfig;
}

beforeEach(() => {
  modelSwitchConfirmStore().resetForTest();
});

afterEach(() => {
  resetKimiClientDeps();
  vi.useRealTimers();
  modelSwitchConfirmStore().resetForTest();
});

describe('refresh', () => {
  it('fetches the config through the server endpoint and stores it in memory', async () => {
    const getClientConfig = stubApi(async () => CLOUD_CONFIG);

    await modelSwitchConfirmStore().refresh();

    expect(modelSwitchConfirmStore().peek()).toEqual(CLOUD_CONFIG);
    expect(getClientConfig).toHaveBeenCalledWith('model_switch_confirm', undefined);
  });

  it('stays empty when the endpoint returns null or rejects', async () => {
    stubApi(async () => null);
    await modelSwitchConfirmStore().refresh();
    expect(modelSwitchConfirmStore().peek()).toBeUndefined();

    stubApi(async () => {
      throw new Error('server down');
    });
    await modelSwitchConfirmStore().refresh();
    expect(modelSwitchConfirmStore().peek()).toBeUndefined();
  });

  it('parses the payload tolerantly — a garbage payload disables the feature', async () => {
    stubApi(async () => 'nope');

    await modelSwitchConfirmStore().refresh();

    expect(modelSwitchConfirmStore().peek()).toEqual({ enable: false, rules: [] });
  });

  it('always refetches — there is no cache TTL', async () => {
    const getClientConfig = stubApi(async () => CLOUD_CONFIG);

    await modelSwitchConfirmStore().refresh();
    await modelSwitchConfirmStore().refresh();

    expect(getClientConfig).toHaveBeenCalledTimes(2);
  });

  it('forwards read options to the api', async () => {
    const getClientConfig = stubApi(async () => CLOUD_CONFIG);
    const controller = new AbortController();

    await modelSwitchConfirmStore().refresh({ signal: controller.signal });

    expect(getClientConfig).toHaveBeenCalledWith('model_switch_confirm', { signal: controller.signal });
  });
});

describe('requestConfirm / settle', () => {
  it('resolves with the settled action and clears pending', async () => {
    const store = modelSwitchConfirmStore();
    const promise = store.requestConfirm({ fromModel: 'A', toModel: 'B', hint: 'hint' });
    expect(store.pending).toMatchObject({ fromModel: 'A', toModel: 'B', hint: 'hint' });

    store.settle('compact');

    await expect(promise).resolves.toBe('compact');
    expect(store.pending).toBeNull();
  });

  it('cancels a previous pending request when a new one arrives', async () => {
    const store = modelSwitchConfirmStore();
    const first = store.requestConfirm({ fromModel: 'A', toModel: 'B' });
    const second = store.requestConfirm({ fromModel: 'C', toModel: 'D' });

    await expect(first).resolves.toBe('cancel');
    expect(store.pending).toMatchObject({ fromModel: 'C', toModel: 'D' });

    store.settle('continue');
    await expect(second).resolves.toBe('continue');
  });
});

describe('waitCompactionSettled', () => {
  it('resolves completed when the compaction completes', async () => {
    const store = modelSwitchConfirmStore();
    const promise = store.waitCompactionSettled('ses-1', 10_000);
    store.noteCompactionSettled('ses-1', 'completed');

    await expect(promise).resolves.toBe('completed');
  });

  it('ignores settlements for other sessions', async () => {
    vi.useFakeTimers();
    const store = modelSwitchConfirmStore();
    const promise = store.waitCompactionSettled('ses-1', 1_000);
    store.noteCompactionSettled('ses-2', 'completed');
    store.noteCompactionSettled('ses-1', 'cancelled');

    await expect(promise).resolves.toBe('cancelled');
  });

  it('shares one wait between callers for the same session', async () => {
    const store = modelSwitchConfirmStore();
    const first = store.waitCompactionSettled('ses-1', 10_000);
    const second = store.waitCompactionSettled('ses-1', 10_000);

    store.noteCompactionSettled('ses-1', 'completed');
    await expect(first).resolves.toBe('completed');
    await expect(second).resolves.toBe('completed');
  });

  it('cancels a pending wait for a different session', async () => {
    const store = modelSwitchConfirmStore();
    const first = store.waitCompactionSettled('ses-1', 10_000);
    const second = store.waitCompactionSettled('ses-2', 10_000);

    await expect(first).resolves.toBe('cancelled');
    store.noteCompactionSettled('ses-2', 'completed');
    await expect(second).resolves.toBe('completed');
  });

  it('resolves timeout when nothing settles', async () => {
    vi.useFakeTimers();
    const store = modelSwitchConfirmStore();
    const promise = store.waitCompactionSettled('ses-1', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toBe('timeout');
  });

  it('settles immediately on request-failed and clears the wait', async () => {
    const store = modelSwitchConfirmStore();
    expect(store.hasCompactionWait('ses-1')).toBe(false);

    const promise = store.waitCompactionSettled('ses-1', 10_000);
    expect(store.hasCompactionWait('ses-1')).toBe(true);

    store.noteCompactionSettled('ses-1', 'request-failed');

    await expect(promise).resolves.toBe('request-failed');
    expect(store.hasCompactionWait('ses-1')).toBe(false);
  });
});
