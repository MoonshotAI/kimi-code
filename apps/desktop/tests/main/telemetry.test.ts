import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createCloudAppenderMock, createKimiDeviceIdMock, logMock } = vi.hoisted(() => ({
  createCloudAppenderMock: vi.fn(),
  createKimiDeviceIdMock: vi.fn(
    (_home: string, _options?: { onFirstLaunch?: () => void }) => 'device-1',
  ),
  logMock: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@moonshot-ai/agent-core-v2', () => ({
  createCloudAppender: createCloudAppenderMock,
  IConfigService: 'IConfigService',
  IOAuthToolkit: 'IOAuthToolkit',
  ITelemetryService: 'ITelemetryService',
}));
vi.mock('@moonshot-ai/kimi-code-oauth', () => ({
  createKimiDeviceId: createKimiDeviceIdMock,
}));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  resolveKimiHome: () => '/tmp/kimi-test',
}));
vi.mock('../../src/main/log', () => ({ log: logMock }));

import {
  isTelemetryConsentEnabled,
  wireDesktopTelemetry,
} from '../../src/main/telemetry';

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
    createKimiDeviceIdMock.mockReset().mockReturnValue('device-1');
    logMock.info.mockClear();
    logMock.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null without touching the telemetry service when config opts out', async () => {
    const { core, telemetryService } = makeCore(false);
    const handle = await wireDesktopTelemetry(core as never);
    expect(handle).toBeNull();
    expect(telemetryService.setAppender).not.toHaveBeenCalled();
    expect(createCloudAppenderMock).not.toHaveBeenCalled();
  });

  it('returns null when KIMI_DISABLE_TELEMETRY is truthy', async () => {
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', 'yes');
    const { core, telemetryService } = makeCore(undefined);
    const handle = await wireDesktopTelemetry(core as never);
    expect(handle).toBeNull();
    expect(telemetryService.setAppender).not.toHaveBeenCalled();
  });

  it('wires the cloud appender with desktop identity and starts periodic flush + disk retry', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService, auth } = makeCore(undefined);

    const handle = await wireDesktopTelemetry(core as never);

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
    expect(telemetryService.track2).not.toHaveBeenCalledWith('first_launch');
  });

  it('maps an undefined cached token to null for the transport', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, auth } = makeCore(undefined);
    auth.getCachedAccessToken.mockResolvedValue(undefined);

    await wireDesktopTelemetry(core as never);
    const host = createCloudAppenderMock.mock.calls[0]![1];
    await expect(host.getAccessToken()).resolves.toBeNull();
  });

  it('tracks first_launch only after the appender is installed', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    createKimiDeviceIdMock.mockImplementation((_home: string, options?: { onFirstLaunch?: () => void }) => {
      options?.onFirstLaunch?.();
      return 'device-new';
    });
    const { core, telemetryService } = makeCore(undefined);

    await wireDesktopTelemetry(core as never);

    expect(telemetryService.track2).toHaveBeenCalledWith('first_launch');
    expect(telemetryService.setAppender.mock.invocationCallOrder[0]).toBeLessThan(
      telemetryService.track2.mock.invocationCallOrder[0]!,
    );
  });

  it('still wires when the config read throws (defaults to enabled)', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService } = makeCore(undefined, { getThrows: true });

    const handle = await wireDesktopTelemetry(core as never);
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
    const handle = await wireDesktopTelemetry(core as never);
    expect(handle).toBeNull();
    expect(logMock.error).toHaveBeenCalledOnce();
  });

  it('shutdown emits exit, stops periodic flush, flushes, and is idempotent', async () => {
    const appender = makeAppender();
    createCloudAppenderMock.mockReturnValue(appender);
    const { core, telemetryService } = makeCore(undefined);

    const handle = await wireDesktopTelemetry(core as never);
    expect(handle).not.toBeNull();
    await Promise.all([handle!.shutdown(), handle!.shutdown()]);

    expect(telemetryService.track2).toHaveBeenCalledOnce();
    expect(telemetryService.track2).toHaveBeenCalledWith('exit', {
      duration_ms: expect.any(Number),
    });
    expect(appender.stopPeriodicFlush).toHaveBeenCalledOnce();
    expect(telemetryService.shutdown).toHaveBeenCalledOnce();
  });
});
