import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteControlStatus } from '@moonshot-ai/app-core/api';
import type { RcDevice, RcDeviceList } from '@moonshot-ai/app-core/lib';

import {
  alreadyRunningHolder,
  remoteControlErrorText,
  useRemoteControl,
  type RemoteControlApi,
} from '../../src/renderer/composables/useRemoteControl';
import { createRemoteControlQrDataUrl } from '../../src/renderer/lib/remoteControlQr';
import { rendererTrackEventSchema } from '../../src/shared/track-events';

const DEVICE: RcDevice = {
  device_id: 'device-1',
  alias: 'Workstation',
  status: 'online',
  platform: 'darwin',
  client_version: 'Kimi Code/1.0.0',
  local_base_url: 'http://127.0.0.1:58627',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_remote_access_at: '2026-01-01T00:00:00.000Z',
};

function status(enabled: boolean, overrides: Partial<RemoteControlStatus> = {}): RemoteControlStatus {
  return {
    enabled,
    state: enabled ? 'on' : 'off',
    url: enabled ? 'https://rc.example.test/devices/device-1/' : undefined,
    device_id: enabled ? 'device-1' : undefined,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function apiStub(overrides: Partial<RemoteControlApi> = {}): RemoteControlApi {
  return {
    getRemoteControlStatus: vi.fn(async () => status(false)),
    setRemoteControlEnabled: vi.fn(async (enabled: boolean) => status(enabled)),
    listRemoteControlDevices: vi.fn(async (): Promise<RcDeviceList> => ({
      devices: [DEVICE],
      max_devices: 3,
    })),
    renameRemoteControlDevice: vi.fn(async () => {}),
    deactivateRemoteControlDevice: vi.fn(async () => {}),
    deleteRemoteControlDevice: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as { kimiDesktop?: unknown }).kimiDesktop;
});

describe('useRemoteControl', () => {
  it('loads status and devices on open regardless of the tunnel state', async () => {
    const offApi = apiStub();
    const off = useRemoteControl(offApi);
    await off.open();
    expect(off.status.value?.enabled).toBe(false);
    expect(offApi.listRemoteControlDevices).toHaveBeenCalledTimes(1);
    expect(off.devices.value).toEqual([DEVICE]);

    const onApi = apiStub({
      getRemoteControlStatus: vi.fn(async () => status(true)),
    });
    const on = useRemoteControl(onApi);
    await on.open();
    expect(on.devices.value).toEqual([DEVICE]);
  });

  it('loads the restore preference independently of the current switch state', async () => {
    const getRemoteControlRestoreState = vi.fn(async () => ({
      restoreEnabled: true,
      previousEnabled: false,
    }));
    (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
      getRemoteControlRestoreState,
    };
    const control = useRemoteControl(apiStub());

    await control.open();

    expect(control.status.value?.enabled).toBe(false);
    expect(control.restoreEnabled.value).toBe(true);
    expect(getRemoteControlRestoreState).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'captures the current switch state (%s) when enabling the restore preference',
    async (currentEnabled) => {
      const setRemoteControlRestoreState = vi.fn(async () => {});
      (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
        setRemoteControlRestoreState,
      };
      const api = apiStub();
      const control = useRemoteControl(api);
      control.status.value = status(currentEnabled);

      await control.setRestoreEnabled(true);

      expect(control.restoreEnabled.value).toBe(true);
      expect(setRemoteControlRestoreState).toHaveBeenCalledWith({ restoreEnabled: true });
      expect(setRemoteControlRestoreState).toHaveBeenCalledWith({ previousEnabled: currentEnabled });
      expect(api.setRemoteControlEnabled).not.toHaveBeenCalled();
    },
  );

  it('persists the previous switch state only after a successful toggle', async () => {
    const setRemoteControlRestoreState = vi.fn(async () => {});
    (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
      setRemoteControlRestoreState,
    };
    const api = apiStub();
    const control = useRemoteControl(api);

    await control.setEnabled(true);
    expect(setRemoteControlRestoreState).toHaveBeenLastCalledWith({ previousEnabled: true });
    await control.setEnabled(false);
    expect(setRemoteControlRestoreState).toHaveBeenLastCalledWith({ previousEnabled: false });

    api.setRemoteControlEnabled = vi.fn(async () => {
      throw new Error('failed');
    });
    await control.setEnabled(true);
    expect(setRemoteControlRestoreState).toHaveBeenCalledTimes(2);
  });

  it('saves the actual terminal state instead of a failed enable request', async () => {
    const setRemoteControlRestoreState = vi.fn(async () => {});
    (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
      setRemoteControlRestoreState,
    };
    const api = apiStub({
      setRemoteControlEnabled: vi.fn(async () => status(false, { state: 'starting' })),
      getRemoteControlStatus: vi.fn(async () => status(false)),
    });
    const control = useRemoteControl(api);

    await control.setEnabled(true);
    expect(setRemoteControlRestoreState).not.toHaveBeenCalled();

    await control.loadStatus();
    expect(setRemoteControlRestoreState).toHaveBeenCalledWith({ previousEnabled: false });
  });

  it('does not reuse a stale state when the current state is unknown', async () => {
    const setRemoteControlRestoreState = vi.fn(async () => {});
    (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
      setRemoteControlRestoreState,
    };
    const control = useRemoteControl(apiStub());

    await control.setRestoreEnabled(true);

    expect(setRemoteControlRestoreState).toHaveBeenCalledWith({ previousEnabled: false });
  });

  it('reloads status when background restoration finishes', async () => {
    let finished!: () => void;
    const off = vi.fn();
    (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
      getRemoteControlRestoreState: vi.fn(async () => ({
        restoreEnabled: true,
        previousEnabled: true,
      })),
      onRemoteControlRestoreFinished: vi.fn((cb: () => void) => {
        finished = cb;
        return off;
      }),
    };
    const api = apiStub();
    const control = useRemoteControl(api);
    await control.open();
    const calls = vi.mocked(api.getRemoteControlStatus).mock.calls.length;

    finished();
    await vi.waitFor(() => {
      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(calls + 1);
    });
    control.dispose();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('polls while the status is transitional and stops at a terminal state', async () => {
    vi.useFakeTimers();
    try {
      const states = [
        status(false, { state: 'starting' }),
        status(false, { state: 'starting' }),
        status(true),
      ];
      const api = apiStub({
        getRemoteControlStatus: vi.fn(() =>
          Promise.resolve(states.length > 1 ? states.shift()! : states[0]!),
        ),
      });
      const control = useRemoteControl(api);
      await control.loadStatus();
      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the toggle response when an earlier read resolves stale afterwards', async () => {
    const read = deferred<RemoteControlStatus>();
    const toggle = deferred<RemoteControlStatus>();
    const api = apiStub({
      getRemoteControlStatus: vi.fn(() => read.promise),
      setRemoteControlEnabled: vi.fn(() => toggle.promise),
    });
    const control = useRemoteControl(api);

    const refreshing = control.loadStatus();
    const enabling = control.setEnabled(true);
    toggle.resolve(status(true));
    await enabling;
    read.resolve(status(false));
    await refreshing;

    expect(control.status.value?.enabled).toBe(true);
  });

  it('suppresses status reads while a toggle is in flight', async () => {
    const toggle = deferred<RemoteControlStatus>();
    const api = apiStub({
      setRemoteControlEnabled: vi.fn(() => toggle.promise),
    });
    const control = useRemoteControl(api);

    const enabling = control.setEnabled(true);
    await control.loadStatus();
    expect(api.getRemoteControlStatus).not.toHaveBeenCalled();
    toggle.resolve(status(true));
    await enabling;

    expect(control.status.value?.enabled).toBe(true);
  });

  it('stops scheduling polls after dispose even with a request in flight', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<RemoteControlStatus>();
      let calls = 0;
      const api = apiStub({
        getRemoteControlStatus: vi.fn(() => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(status(false, { state: 'starting' }))
            : pending.promise;
        }),
      });
      const control = useRemoteControl(api);
      await control.loadStatus();

      await vi.advanceTimersByTimeAsync(1000);
      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(2);
      control.dispose();
      pending.resolve(status(false, { state: 'starting' }));
      await pending.promise;
      await vi.advanceTimersByTimeAsync(5000);

      expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dedupes enable submissions and refreshes devices after turning on', async () => {
    const pending = deferred<RemoteControlStatus>();
    const api = apiStub({
      setRemoteControlEnabled: vi.fn(() => pending.promise),
    });
    const control = useRemoteControl(api);

    const first = control.setEnabled(true);
    const second = control.setEnabled(true);
    expect(api.setRemoteControlEnabled).toHaveBeenCalledTimes(1);
    expect(control.enabling.value).toBe(true);

    pending.resolve(status(true));
    await Promise.all([first, second]);
    expect(api.listRemoteControlDevices).toHaveBeenCalledTimes(1);
    expect(control.devices.value).toEqual([DEVICE]);
  });

  it('clears the pending toggle state when a status refresh lands mid-toggle', async () => {
    const pending = deferred<RemoteControlStatus>();
    const api = apiStub({
      setRemoteControlEnabled: vi.fn(() => pending.promise),
    });
    const control = useRemoteControl(api);

    const toggle = control.setEnabled(true);
    expect(control.enabling.value).toBe(true);

    await control.loadStatus();
    pending.resolve(status(true));
    await toggle;

    expect(control.enabling.value).toBe(false);
    expect(control.disabling.value).toBe(false);
  });

  it('trims rename input and reloads status and devices', async () => {
    const api = apiStub({
      getRemoteControlStatus: vi.fn(async () => status(true)),
    });
    const control = useRemoteControl(api);
    await control.open();

    await control.renameDevice('device-1', '  Renamed  ');

    expect(api.renameRemoteControlDevice).toHaveBeenCalledWith('device-1', 'Renamed');
    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(2);
    expect(api.listRemoteControlDevices).toHaveBeenCalledTimes(2);
  });

  it('returns to the off state and refreshes devices after the current device is deactivated', async () => {
    const setRemoteControlRestoreState = vi.fn(async () => {});
    (globalThis as { kimiDesktop?: unknown }).kimiDesktop = {
      setRemoteControlRestoreState,
    };
    const api = apiStub({
      getRemoteControlStatus: vi
        .fn(async () => status(true))
        .mockResolvedValueOnce(status(true))
        .mockResolvedValue(status(false)),
    });
    const control = useRemoteControl(api);
    await control.open();

    await control.deactivateDevice('device-1');

    expect(api.deactivateRemoteControlDevice).toHaveBeenCalledWith('device-1');
    expect(setRemoteControlRestoreState).toHaveBeenCalledWith({ previousEnabled: false });
    expect(control.status.value?.enabled).toBe(false);
    expect(control.devices.value).toEqual([DEVICE]);
    expect(api.listRemoteControlDevices).toHaveBeenCalledTimes(2);
  });

  it('deletes a device through the cloud registry and refreshes devices', async () => {
    const api = apiStub({
      listRemoteControlDevices: vi
        .fn(async (): Promise<RcDeviceList> => ({ devices: [DEVICE], max_devices: 3 }))
        .mockResolvedValueOnce({ devices: [DEVICE], max_devices: 3 })
        .mockResolvedValue({ devices: [], max_devices: 3 }),
    });
    const control = useRemoteControl(api);
    await control.open();

    await control.deleteDevice('device-1');

    expect(api.deleteRemoteControlDevice).toHaveBeenCalledWith('device-1');
    expect(api.deactivateRemoteControlDevice).not.toHaveBeenCalled();
    expect(control.devices.value).toEqual([]);
    expect(api.listRemoteControlDevices).toHaveBeenCalledTimes(2);
  });

  it('ignores stale device list responses', async () => {
    const first = deferred<RcDeviceList>();
    const second = deferred<RcDeviceList>();
    const list = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const control = useRemoteControl(apiStub({
      getRemoteControlStatus: vi.fn(async () => status(true)),
      listRemoteControlDevices: list,
    }));
    control.status.value = status(true);

    const firstRequest = control.refreshDevices();
    const secondRequest = control.refreshDevices();
    second.resolve({ devices: [{ ...DEVICE, alias: 'Newest' }] });
    await secondRequest;
    first.resolve({ devices: [{ ...DEVICE, alias: 'Stale' }] });
    await firstRequest;

    expect(control.devices.value?.[0]?.alias).toBe('Newest');
    expect(control.devicesRefreshing.value).toBe(false);
  });

  it('adopts the conflict reported by the status response', async () => {
    const api = apiStub({
      getRemoteControlStatus: vi.fn(async () =>
        status(false, {
          error: 'Remote Control is already running',
          conflict: {
            pid: 65733,
            local_origin: 'http://127.0.0.1:58627',
            device_id: 'device-1',
            url: 'https://rc.example.test/devices/device-1/',
            started_at: 1700000000000,
          },
        }),
      ),
    });
    const control = useRemoteControl(api);
    await control.open();
    expect(control.conflict.value?.pid).toBe(65733);
    expect(control.conflict.value?.url).toBe('https://rc.example.test/devices/device-1/');
  });

  it('surfaces a structured conflict instead of an error when another process holds the lock', async () => {
    const api = apiStub({
      setRemoteControlEnabled: vi.fn(async () => {
        throw {
          name: 'DaemonApiError',
          code: 40928,
          message: 'Remote Control is already running',
          details: {
            pid: 65472,
            local_origin: 'http://127.0.0.1:58627',
            device_id: 'device-1',
            url: 'https://rc.example.test/devices/device-1/',
            started_at: 1700000000000,
          },
        };
      }),
    });
    const control = useRemoteControl(api);

    await control.setEnabled(true);

    expect(control.conflict.value?.pid).toBe(65472);
    expect(control.conflict.value?.url).toBe('https://rc.example.test/devices/device-1/');
    expect(control.toggleError.value).toBeNull();

    api.setRemoteControlEnabled = vi.fn(async (enabled: boolean) => status(enabled));
    await control.setEnabled(true);
    expect(control.conflict.value).toBeNull();
    expect(control.status.value?.enabled).toBe(true);
  });

  it('takes over from another process by deactivating it and enabling locally', async () => {
    const calls: string[] = [];
    const api = apiStub({
      getRemoteControlStatus: vi.fn(async () =>
        status(false, {
          conflict: {
            pid: 65733,
            local_origin: 'http://127.0.0.1:58627',
            device_id: 'device-1',
            url: 'https://rc.example.test/devices/device-1/',
            started_at: 1700000000000,
          },
        }),
      ),
      deactivateRemoteControlDevice: vi.fn(async () => {
        calls.push('deactivate');
      }),
      setRemoteControlEnabled: vi.fn(async (enabled: boolean) => {
        calls.push('enable');
        return status(enabled);
      }),
    });
    const control = useRemoteControl(api);
    await control.open();
    expect(control.conflict.value?.pid).toBe(65733);

    await control.takeover();

    expect(calls).toEqual(['deactivate', 'enable']);
    expect(api.deactivateRemoteControlDevice).toHaveBeenCalledWith('device-1');
    expect(control.status.value?.enabled).toBe(true);
    expect(control.conflict.value).toBeNull();
    expect(control.takingOver.value).toBe(false);
  });

  it('aborts takeover and reloads status when deactivating the holder fails', async () => {
    const api = apiStub({
      getRemoteControlStatus: vi.fn(async () =>
        status(false, {
          conflict: {
            pid: 65733,
            local_origin: 'http://127.0.0.1:58627',
            device_id: 'device-1',
            url: 'https://rc.example.test/devices/device-1/',
            started_at: 1700000000000,
          },
        }),
      ),
      deactivateRemoteControlDevice: vi.fn(async () => {
        throw new Error('cloud unavailable');
      }),
    });
    const control = useRemoteControl(api);
    await control.open();

    await expect(control.takeover()).rejects.toThrow('cloud unavailable');

    expect(api.setRemoteControlEnabled).not.toHaveBeenCalled();
    expect(control.conflict.value?.device_id).toBe('device-1');
    expect(control.takingOver.value).toBe(false);
  });

  it('keeps the conflict card when the holder is still alive after takeover', async () => {
    const api = apiStub({
      getRemoteControlStatus: vi.fn(async () =>
        status(false, {
          conflict: {
            pid: 65733,
            local_origin: 'http://127.0.0.1:58627',
            device_id: 'device-1',
            url: 'https://rc.example.test/devices/device-1/',
            started_at: 1700000000000,
          },
        }),
      ),
      setRemoteControlEnabled: vi.fn(async () => {
        throw {
          name: 'DaemonApiError',
          code: 40928,
          message: 'Remote Control is already running',
          details: {
            pid: 65733,
            local_origin: 'http://127.0.0.1:58627',
            device_id: 'device-1',
            url: 'https://rc.example.test/devices/device-1/',
            started_at: 1700000000000,
          },
        };
      }),
    });
    const control = useRemoteControl(api);
    await control.open();

    await control.takeover();

    expect(api.deactivateRemoteControlDevice).toHaveBeenCalledWith('device-1');
    expect(control.conflict.value?.pid).toBe(65733);
    expect(control.status.value?.enabled).toBe(false);
    expect(control.takingOver.value).toBe(false);
  });

  it('extracts the lock holder only from a matching api error', () => {expect(
      alreadyRunningHolder({
        name: 'DaemonApiError',
        code: 40928,
        message: 'already running',
        details: {
          pid: 1234,
          local_origin: 'http://127.0.0.1:58627',
          device_id: 'device-1',
          url: 'https://rc.example.test/devices/device-1/',
          started_at: 1700000000000,
        },
      }),
    ).toEqual({
      pid: 1234,
      local_origin: 'http://127.0.0.1:58627',
      device_id: 'device-1',
      url: 'https://rc.example.test/devices/device-1/',
      started_at: 1700000000000,
    });
    expect(alreadyRunningHolder(new Error('boom'))).toBeUndefined();
    expect(
      alreadyRunningHolder({ name: 'DaemonApiError', code: 40001, message: 'x', details: {} }),
    ).toBeUndefined();
    expect(
      alreadyRunningHolder({ name: 'DaemonApiError', code: 40928, message: 'x', details: {} }),
    ).toBeUndefined();
  });

  it('keeps raw server messages and falls back for empty errors', () => {
    expect(remoteControlErrorText(new Error('cloud unavailable'), 'fallback')).toBe('cloud unavailable');
    expect(remoteControlErrorText(new Error(' '), 'fallback')).toBe('fallback');
  });
});

describe('remote control QR', () => {
  it('generates a real PNG QR code from the status URL', async () => {
    const first = await createRemoteControlQrDataUrl('https://rc.example.test/devices/device-1/?rc=1');
    const second = await createRemoteControlQrDataUrl('https://rc.example.test/devices/device-2/?rc=1');

    expect(first).toMatch(/^data:image\/png;base64,/);
    expect(second).toMatch(/^data:image\/png;base64,/);
    expect(first).not.toBe(second);
  });
});

describe('remote control track event schema', () => {
  it('accepts every payload shape the components emit', () => {
    const payloads = [
      { action: 'enable', outcome: 'ok' },
      { action: 'enable', outcome: 'error' },
      { action: 'enable', outcome: 'conflict' },
      { action: 'enable', outcome: 'login_required' },
      { action: 'disable', outcome: 'ok' },
      { action: 'disable', outcome: 'error' },
      { action: 'takeover', outcome: 'ok' },
      { action: 'takeover', outcome: 'error' },
      { action: 'takeover', outcome: 'cancelled' },
      { action: 'copy_link', source: 'panel', outcome: 'ok' },
      { action: 'copy_link', source: 'conflict_dialog', outcome: 'error' },
      { action: 'open_link', source: 'panel' },
      { action: 'open_link', source: 'conflict_dialog' },
      { action: 'refresh_devices' },
      { action: 'rename', outcome: 'ok' },
      { action: 'rename', outcome: 'error' },
      { action: 'rename', outcome: 'cancelled' },
      { action: 'deactivate', outcome: 'ok', target: 'current_device' },
      { action: 'delete', outcome: 'cancelled', target: 'other_device' },
    ];
    for (const properties of payloads) {
      expect(rendererTrackEventSchema.safeParse({ event: 'remote_control_action', properties }).success).toBe(true);
    }
  });

  it('rejects payloads outside the declared shapes', () => {
    const invalid = [
      { action: 'enable', outcome: 'cancelled' },
      { action: 'copy_link', outcome: 'ok' },
      { action: 'deactivate', outcome: 'ok' },
      { action: 'delete', outcome: 'ok', target: 'device-1' },
    ];
    for (const properties of invalid) {
      expect(rendererTrackEventSchema.safeParse({ event: 'remote_control_action', properties }).success).toBe(false);
    }
  });
});

describe('browser autoplay telemetry', () => {
  it('accepts only the fixed global setting and rejects URLs and site data', () => {
    expect(rendererTrackEventSchema.safeParse({ event: 'settings_changed', properties: { key: 'browser-autoplay', value: 'block', source_panel: 'settings' } }).success).toBe(true);
    for (const properties of [
      { key: 'browser-autoplay', value: 'https://example.test/media', source_panel: 'settings' },
      { key: 'https://example.test', value: 'allow', source_panel: 'settings' },
    ]) expect(rendererTrackEventSchema.safeParse({ event: 'settings_changed', properties }).success).toBe(false);
    const projected = rendererTrackEventSchema.safeParse({ event: 'settings_changed', properties: { key: 'browser-autoplay', value: 'allow', source_panel: 'settings', origin: 'https://example.test' } });
    expect(projected.success).toBe(true);
    expect(projected.data?.properties).not.toHaveProperty('origin');
  });
});
