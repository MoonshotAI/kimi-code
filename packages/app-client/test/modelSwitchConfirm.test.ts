import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiWebApi } from '@moonshot-ai/app-core/api';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { modelSwitchConfirmStore } from '../src/stores/modelSwitchConfirm';
import { effortSwitchStore } from '../src/stores/effortSwitch';

const CLOUD_CONFIG = {
  enable: true,
  rules: [
    {
      from: 'kimi-k2.5',
      to: 'kimi-k2-turbo-preview',
      session_type: 'old',
      hint: { en: 'Cache lost.', zh: '缓存失效。' },
    },
  ],
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
  effortSwitchStore().resetForTest();
});

afterEach(() => {
  resetKimiClientDeps();
  vi.useRealTimers();
  modelSwitchConfirmStore().resetForTest();
  effortSwitchStore().resetForTest();
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

  it('shares one request between concurrent refreshes', async () => {
    let release!: () => void;
    const getClientConfig = stubApi(
      () =>
        new Promise((resolve) => {
          release = () => resolve(CLOUD_CONFIG);
        }),
    );

    const first = modelSwitchConfirmStore().refresh();
    const second = modelSwitchConfirmStore().refresh();

    expect(getClientConfig).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(modelSwitchConfirmStore().peek()).toEqual(CLOUD_CONFIG);
  });

  it('marks empty and failed loads as settled for automatic picker loads', async () => {
    const store = modelSwitchConfirmStore();
    const getClientConfig = stubApi(async () => null);
    expect(store.needsLoad()).toBe(true);

    await store.refresh();
    expect(store.needsLoad()).toBe(false);

    await store.refresh();
    expect(getClientConfig).toHaveBeenCalledTimes(2);

    stubApi(async () => {
      throw new Error('server down');
    });
    await store.refresh();
    expect(store.needsLoad()).toBe(false);
  });

  it('does not share requests across signals or let an aborted generation clear newer config', async () => {
    const store = modelSwitchConfirmStore();
    const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
    const getClientConfig = stubApi(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = store.refresh({ signal: firstController.signal });
    firstController.abort();
    const second = store.refresh({ signal: secondController.signal });
    expect(getClientConfig).toHaveBeenCalledTimes(2);

    pending[1]!.resolve(CLOUD_CONFIG);
    await second;
    pending[0]!.reject(new Error('aborted'));
    await first;

    expect(store.peek()).toEqual(CLOUD_CONFIG);
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
    const promise = store.requestConfirm({ fromModel: 'A', toModel: 'B', sessionType: 'old', hint: 'hint' });
    expect(store.pending).toMatchObject({ fromModel: 'A', toModel: 'B', sessionType: 'old', hint: 'hint' });

    store.settle('compact');

    await expect(promise).resolves.toBe('compact');
    expect(store.pending).toBeNull();
  });

  it('cancels a previous pending request when a new one arrives', async () => {
    const store = modelSwitchConfirmStore();
    const first = store.requestConfirm({ fromModel: 'A', toModel: 'B', sessionType: 'old' });
    const second = store.requestConfirm({ fromModel: 'C', toModel: 'D', sessionType: 'new' });

    await expect(first).resolves.toBe('cancel');
    expect(store.pending).toMatchObject({ fromModel: 'C', toModel: 'D', sessionType: 'new' });

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

  it('tracks pending waits independently per session', async () => {
    const store = modelSwitchConfirmStore();
    const first = store.waitCompactionSettled('ses-1', 10_000);
    const second = store.waitCompactionSettled('ses-2', 10_000);

    expect(store.hasCompactionWait('ses-1')).toBe(true);
    expect(store.hasCompactionWait('ses-2')).toBe(true);

    store.noteCompactionSettled('ses-2', 'completed');
    await expect(second).resolves.toBe('completed');
    expect(store.hasCompactionWait('ses-1')).toBe(true);

    store.noteCompactionSettled('ses-1', 'completed');
    await expect(first).resolves.toBe('completed');
    expect(store.hasCompactionWait('ses-1')).toBe(false);
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


describe('effort switch store', () => {
  it('loads effort_switch_confirm and settles the load state', async () => {
    const config = {
      descriptions: { enable: true, items: { low: { en: 'Light reasoning.', zh: '轻量思考。' } } },
      confirm: { enable: true, rules: [{ from: 'low', to: 'high', session_type: 'all' }] },
    };
    const getClientConfig = stubApi(async () => config);
    const store = effortSwitchStore();

    await store.refresh();

    expect(getClientConfig).toHaveBeenCalledWith('effort_switch_confirm', undefined);
    expect(store.peek()).toEqual(config);
    expect(store.needsLoad()).toBe(false);
  });

  it('resolves confirm and cancel actions', async () => {
    const store = effortSwitchStore();
    const first = store.requestConfirm({ fromEffort: 'low', toEffort: 'high', sessionType: 'old' });
    store.settle('continue');
    await expect(first).resolves.toBe('continue');

    const second = store.requestConfirm({ fromEffort: 'high', toEffort: 'max', sessionType: 'new' });
    store.settle('cancel');
    await expect(second).resolves.toBe('cancel');
  });
});
