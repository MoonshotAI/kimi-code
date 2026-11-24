import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDevice, AppSystemStats } from '@moonshot-ai/app-core/api';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useDeviceStats, type DeviceStatsTarget } from '../src/composables/useDeviceStats';
import { devicesStore, setDevicesHooks } from '../src/stores/devices';

const remote = {
  getMeta: vi.fn(),
  getAuth: vi.fn(),
  getSystemStats: vi.fn(),
};

const api = {
  deviceApi: vi.fn(() => remote),
  listDevices: vi.fn(),
};

function reading(cpu: number): AppSystemStats {
  return { cpu: { usage: cpu, cores: 8, limited: false }, memory: { total: 16, used: 8, limited: false }, gpus: [] };
}

function device(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'ssh', host: `${id}.example.test`, status: 'ready', ...extra };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await nextTick();
}

function track(target: () => DeviceStatsTarget | undefined) {
  const scope = effectScope();
  const result = scope.run(() => useDeviceStats(target))!;
  return { ...result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of [...Object.values(remote), ...Object.values(api)]) fn.mockReset();
  api.deviceApi.mockReturnValue(remote);
  remote.getMeta.mockResolvedValue({ capabilities: { system_stats: true } });
  remote.getAuth.mockResolvedValue({ modelsReady: true, providersCount: 1, managedProvider: null });
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
  setDevicesHooks(null);
  devicesStore().applySnapshot([]);
});

afterEach(() => {
  vi.useRealTimers();
  devicesStore().applySnapshot([]);
  resetKimiClientDeps();
});

describe('useDeviceStats', () => {
  it('polls a ready device that reports stats in the background and stops when released', async () => {
    remote.getSystemStats.mockResolvedValueOnce(reading(0.2)).mockResolvedValueOnce(reading(0.4));
    devicesStore().applySnapshot([device('gpu-box')]);
    await settle();
    const tracked = track(() => ({ deviceId: 'gpu-box', path: '/srv/app' }));
    await settle();

    expect(tracked.stats.value?.cpu.usage).toBe(0.2);
    expect(remote.getSystemStats).toHaveBeenCalledWith('/srv/app', expect.objectContaining({ background: true }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracked.stats.value?.cpu.usage).toBe(0.4);

    tracked.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(remote.getSystemStats).toHaveBeenCalledTimes(2);
  });

  it('does not ask a local session, a disconnected device or a device without the capability', async () => {
    remote.getMeta.mockImplementation(async () => ({ capabilities: {} }));
    devicesStore().applySnapshot([device('old-server'), device('offline', { status: 'disconnected' })]);
    await settle();
    const targets = [undefined, { deviceId: 'old-server' }, { deviceId: 'offline' }];
    const tracked = targets.map((target) => track(() => target));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(remote.getSystemStats).not.toHaveBeenCalled();
    expect(tracked.map(({ stats }) => stats.value)).toEqual([null, null, null]);
    for (const { stop } of tracked) stop();
  });

  it('keeps the last reading as stale while requests fail and backs off', async () => {
    remote.getSystemStats.mockResolvedValueOnce(reading(0.3)).mockRejectedValue(new Error('relay unavailable'));
    devicesStore().applySnapshot([device('gpu-box')]);
    await settle();
    const tracked = track(() => ({ deviceId: 'gpu-box' }));
    await settle();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracked.stale.value).toBe(true);
    expect(tracked.stats.value?.cpu.usage).toBe(0.3);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(remote.getSystemStats).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remote.getSystemStats).toHaveBeenCalledTimes(3);
    tracked.stop();
  });

  it('drops the reading of the previous project as soon as the target changes', async () => {
    const pending = Promise.withResolvers<AppSystemStats>();
    remote.getSystemStats.mockResolvedValueOnce(reading(0.5)).mockReturnValueOnce(pending.promise);
    devicesStore().applySnapshot([device('gpu-box')]);
    await settle();
    const path = ref('/srv/first');
    const tracked = track(() => ({ deviceId: 'gpu-box', path: path.value }));
    await settle();
    expect(tracked.stats.value?.cpu.usage).toBe(0.5);

    path.value = '/srv/second';
    await nextTick();
    expect(tracked.stats.value).toBeNull();
    pending.resolve(reading(0.1));
    await settle();
    expect(tracked.stats.value?.cpu.usage).toBe(0.1);
    tracked.stop();
  });
});
