import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  createCloudAppenderMock,
  logMock,
  systemMetricsMock,
  nativeThemeMock,
  resolveKimiHomeMock,
} = vi.hoisted(() => ({
  createCloudAppenderMock: vi.fn(),
  logMock: { info: vi.fn(), error: vi.fn() },
  systemMetricsMock: { start: vi.fn(), stop: vi.fn() },
  nativeThemeMock: { shouldUseDarkColors: false },
  resolveKimiHomeMock: vi.fn((): string => '/tmp/kimi-telemetry-test'),
}));

vi.mock('electron', () => ({ nativeTheme: nativeThemeMock }));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({ resolveKimiHome: resolveKimiHomeMock }));
vi.mock('@moonshot-ai/agent-core-v2', () => ({
  createCloudAppender: createCloudAppenderMock,
  IConfigService: 'IConfigService',
  IOAuthToolkit: 'IOAuthToolkit',
  ITelemetryService: 'ITelemetryService',
}));
vi.mock('../../src/main/log', () => ({ log: logMock }));
vi.mock('../../src/main/system-metrics', () => ({
  startDesktopSystemMetrics: systemMetricsMock.start,
  stopDesktopSystemMetrics: systemMetricsMock.stop,
}));

import {
  daysSince,
  isTelemetryConsentEnabled,
  resetDaysSinceInstallCacheForTests,
  wireDesktopTelemetry,
} from '../../src/main/telemetry';
import { setDesktopTrackImpl, trackDesktopEvent } from '../../src/main/track';
import {
  getRuntimeLocale,
  getServerMode,
  setRuntimeLocale,
  setServerMode,
} from '../../src/main/runtime-context';

const EXISTING_DEVICE = { deviceId: 'device-1', firstLaunch: false } as const;

function makeCore(configValue: unknown, opts: { getThrows?: boolean } = {}) {
  const configService = {
    ready: Promise.resolve(),
    get: vi.fn(() => {
      if (opts.getThrows === true) throw new Error('unknown key');
      return configValue;
    }),
  };
  const telemetryService = {
    setAppender: vi.fn(),
    track: vi.fn(),
    track2: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const auth = { getCachedAccessToken: vi.fn().mockResolvedValue('tok-1') };
  const services: Record<string, unknown> = {
    IConfigService: configService,
    ITelemetryService: telemetryService,
    IOAuthToolkit: auth,
  };
  const accessor = { get: vi.fn((token: string) => services[token]) };
  return { core: { accessor }, configService, telemetryService, auth };
}

function makeAppender() {
  return {
    startPeriodicFlush: vi.fn(),
    stopPeriodicFlush: vi.fn(),
    retryDiskEvents: vi.fn().mockResolvedValue(undefined),
  };
}

describe('isTelemetryConsentEnabled', () => {
  it('defaults to enabled (opt-out): undefined / non-false config values stay on', () => {
    for (const value of [undefined, null, true, 0, 'false']) {
      expect(isTelemetryConsentEnabled(value, undefined)).toBe(true);
    }
  });

  it('is disabled only by an explicit config false', () => {
    expect(isTelemetryConsentEnabled(false, undefined)).toBe(false);
  });

  it('is disabled by the KIMI_DISABLE_TELEMETRY truthy set, case/whitespace-insensitive', () => {
    for (const env of ['1', 'true', 't', 'yes', 'y', ' TRUE ', 'Yes']) {
      expect(isTelemetryConsentEnabled(undefined, env)).toBe(false);
    }
  });

  it('ignores non-truthy env values', () => {
    for (const env of ['', '0', 'false', 'no', '2']) {
      expect(isTelemetryConsentEnabled(undefined, env)).toBe(true);
    }
  });

  it('env disables even when config enables', () => {
    expect(isTelemetryConsentEnabled(true, '1')).toBe(false);
  });
});

describe('wireDesktopTelemetry', () => {
  beforeEach(() => {
    createCloudAppenderMock.mockReset();
    logMock.info.mockClear();
    logMock.error.mockClear();
    systemMetricsMock.start.mockClear();
    systemMetricsMock.stop.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null without touching the telemetry service when config opts out', async () => {
    const { core, telemetryService } = makeCore(false);
    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).toBeNull();
    expect(telemetryService.setAppender).not.toHaveBeenCalled();
    expect(createCloudAppenderMock).not.toHaveBeenCalled();
    expect(systemMetricsMock.start).not.toHaveBeenCalled();
  });

  it('returns null when KIMI_DISABLE_TELEMETRY is truthy', async () => {
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', 'yes');
    const { core, telemetryService } = makeCore(undefined);
    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).toBeNull();
    expect(telemetryService.setAppender).not.toHaveBeenCalled();
  });

  it('wires the cloud appender with desktop identity and starts periodic flush + disk retry', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService, auth } = makeCore(undefined);

    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);

    expect(handle).not.toBeNull();
    expect(createCloudAppenderMock).toHaveBeenCalledOnce();
    const [accessor, host] = createCloudAppenderMock.mock.calls[0]!;
    expect(accessor).toBe(core.accessor);
    expect(host.deviceId).toBe('device-1');
    expect(host.appName).toBe('kimi-code-desktop');
    expect(host.uiMode).toBe('desktop');
    await expect(host.getAccessToken()).resolves.toBe('tok-1');
    expect(auth.getCachedAccessToken).toHaveBeenCalledOnce();

    expect(telemetryService.setAppender).toHaveBeenCalledWith(appender);
    expect(appender.startPeriodicFlush).toHaveBeenCalledOnce();
    expect(appender.retryDiskEvents).toHaveBeenCalledOnce();
    expect(systemMetricsMock.start).toHaveBeenCalledOnce();
    expect(telemetryService.track2).not.toHaveBeenCalledWith('first_launch');
  });

  it('maps an undefined cached token to null for the transport', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, auth } = makeCore(undefined);
    auth.getCachedAccessToken.mockResolvedValue(undefined);

    await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    const host = createCloudAppenderMock.mock.calls[0]![1];
    await expect(host.getAccessToken()).resolves.toBeNull();
  });

  it('tracks first_launch only after the appender is installed', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService } = makeCore(undefined);

    await wireDesktopTelemetry(core as never, { deviceId: 'device-new', firstLaunch: true });

    expect(telemetryService.track2).toHaveBeenCalledWith('first_launch');
    expect(telemetryService.setAppender.mock.invocationCallOrder[0]).toBeLessThan(
      telemetryService.track2.mock.invocationCallOrder[0]!,
    );
  });

  it('still wires when the config read throws (defaults to enabled)', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService } = makeCore(undefined, { getThrows: true });

    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).not.toBeNull();
    expect(telemetryService.setAppender).toHaveBeenCalledWith(appender);
  });

  it('returns null and logs instead of throwing when wiring fails', async () => {
    const core = {
      accessor: {
        get: vi.fn(() => {
          throw new Error('no such service');
        }),
      },
    };
    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).toBeNull();
    expect(logMock.error).toHaveBeenCalledOnce();
  });

  it('shutdown emits exit, stops periodic flush, flushes, and is idempotent', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService } = makeCore(undefined);

    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).not.toBeNull();
    await Promise.all([handle!.shutdown(), handle!.shutdown()]);

    expect(systemMetricsMock.stop).toHaveBeenCalledOnce();
    expect(telemetryService.track2).toHaveBeenCalledOnce();
    expect(telemetryService.track2).toHaveBeenCalledWith('exit', {
      duration_ms: expect.any(Number),
    });
    expect(appender.stopPeriodicFlush).toHaveBeenCalledOnce();
    expect(telemetryService.shutdown).toHaveBeenCalledOnce();
  });

  it('shutdown resolves within 3s even when the telemetry service never settles', async () => {
    vi.useFakeTimers();
    try {
      const appender = makeAppender();
      createCloudAppenderMock.mockReturnValue(appender);
      const { core, telemetryService } = makeCore(undefined);
      telemetryService.shutdown.mockReturnValue(new Promise<void>(() => {}));

      const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
      expect(handle).not.toBeNull();
      let settled = false;
      const shutdownPromise = handle!.shutdown().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await shutdownPromise;

      expect(settled).toBe(true);
      expect(appender.stopPeriodicFlush).toHaveBeenCalledOnce();
      setDesktopTrackImpl(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('daysSince', () => {
  it('floors whole days and clamps negative values to zero', () => {
    const day = 86_400_000;
    const now = 100 * day;
    expect(daysSince(now, now)).toBe(0);
    expect(daysSince(now - 0.9 * day, now)).toBe(0);
    expect(daysSince(now - 1.5 * day, now)).toBe(1);
    expect(daysSince(now - 42 * day, now)).toBe(42);
    // A birth time in the future (clock skew) never goes negative.
    expect(daysSince(now + day, now)).toBe(0);
  });
});

describe('super properties injection', () => {
  let homeDir: string;

  beforeEach(async () => {
    createCloudAppenderMock.mockReset();
    nativeThemeMock.shouldUseDarkColors = false;
    setServerMode(undefined);
    setRuntimeLocale(undefined);
    resetDaysSinceInstallCacheForTests();
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-telemetry-'));
    resolveKimiHomeMock.mockReturnValue(homeDir);
  });

  afterEach(() => {
    setDesktopTrackImpl(null);
    setServerMode(undefined);
    setRuntimeLocale(undefined);
    vi.unstubAllEnvs();
  });

  function wiredTrack(): ReturnType<typeof vi.fn> {
    createCloudAppenderMock.mockReturnValue(makeAppender());
    return vi.fn();
  }

  it('merges runtime context into every event; event-own fields win', async () => {
    await writeFile(join(homeDir, 'device_id'), 'device-1');
    wiredTrack();
    const { core, telemetryService } = makeCore(undefined);
    setServerMode('embedded');
    setRuntimeLocale('zh');

    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).not.toBeNull();

    trackDesktopEvent('window_lifecycle', { action: 'shown' });
    expect(telemetryService.track).toHaveBeenCalledWith('window_lifecycle', {
      action: 'shown',
      server_mode: 'embedded',
      locale: 'zh',
      theme: 'light',
      days_since_install: 0,
      app_uptime_ms: expect.any(Number),
    });

    // The event's own app_uptime_ms is never overwritten.
    trackDesktopEvent('app_crashed', { process: 'main', kind: 'uncaught_exception', app_uptime_ms: 42 });
    expect(telemetryService.track).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({ app_uptime_ms: 42 }),
    );

    await handle!.shutdown();
  });

  it('omits context values that are unset or unreadable', async () => {
    // No device_id file in homeDir → days_since_install is dropped; server_mode
    // and locale stay unset.
    wiredTrack();
    const { core, telemetryService } = makeCore(undefined);

    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    expect(handle).not.toBeNull();

    trackDesktopEvent('global_shortcut_invoked', {});
    const properties = telemetryService.track.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(properties['server_mode']).toBeUndefined();
    expect(properties['locale']).toBeUndefined();
    expect(properties['days_since_install']).toBeUndefined();
    expect(properties['app_uptime_ms']).toEqual(expect.any(Number));
    expect(properties['theme']).toBe('light');

    await handle!.shutdown();
  });

  it('reflects later context updates and the dark theme', async () => {
    wiredTrack();
    const { core, telemetryService } = makeCore(undefined);
    nativeThemeMock.shouldUseDarkColors = true;

    const handle = await wireDesktopTelemetry(core as never, EXISTING_DEVICE);
    setServerMode('external');
    setRuntimeLocale('en');

    trackDesktopEvent('global_shortcut_invoked', {});
    expect(telemetryService.track).toHaveBeenCalledWith(
      'global_shortcut_invoked',
      expect.objectContaining({ server_mode: 'external', locale: 'en', theme: 'dark' }),
    );

    await handle!.shutdown();
  });
});

describe('runtime-context', () => {
  it('stores server_mode and locale, defaulting to undefined', () => {
    expect(getServerMode()).toBeUndefined();
    expect(getRuntimeLocale()).toBeUndefined();
    setServerMode('embedded');
    setRuntimeLocale('zh');
    expect(getServerMode()).toBe('embedded');
    expect(getRuntimeLocale()).toBe('zh');
    setServerMode(undefined);
    setRuntimeLocale(undefined);
    expect(getServerMode()).toBeUndefined();
    expect(getRuntimeLocale()).toBeUndefined();
  });
});
