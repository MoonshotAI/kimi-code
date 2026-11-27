import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const on = (prefix: string) =>
    vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(`${prefix}:${event}`, listener);
    });
  return {
    listeners,
    info: vi.fn(),
    warn: vi.fn(),
    readRendererJsHeap: vi.fn(async (): Promise<{ used: number; total: number; limit: number } | null> => ({
      used: 120 * 1024 * 1024,
      total: 200 * 1024 * 1024,
      limit: 4096 * 1024 * 1024,
    })),
    getMainWindow: vi.fn((): unknown => null),
    getAppMetrics: vi.fn(() => [
      { type: 'Browser', pid: 1, cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 100_000 } },
      { type: 'Tab', pid: 77, cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 300 * 1024 } },
      { type: 'Tab', pid: 78, cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 100 * 1024 } },
      { type: 'GPU', pid: 9, cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 50 * 1024 } },
    ]),
    getGPUInfo: vi.fn(async (): Promise<unknown> => ({
      gpuDevice: [{ active: true, vendorId: 4203, deviceId: 0, extra: 'drop' }],
      machineModelName: 'MacBookAir',
      machineModelVersion: '10.1',
    })),
    appOn: on('app'),
    powerOn: on('power'),
    screenOn: on('screen'),
    themeOn: on('theme'),
    scheduleDiagnosticPruning: vi.fn(),
  };
});

const gpuStatus = vi.hoisted(() => ({
  current: { gpu_compositing: 'enabled', webgpu: 'disabled_off', rasterization: 'enabled_on' } as Record<string, string>,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3',
    isPackaged: true,
    getLocale: () => 'zh-CN',
    getSystemLocale: () => 'zh-Hans-CN',
    isHardwareAccelerationEnabled: () => true,
    getGPUFeatureStatus: () => gpuStatus.current,
    getGPUInfo: mocks.getGPUInfo,
    getAppMetrics: mocks.getAppMetrics,
    on: mocks.appOn,
  },
  nativeTheme: { shouldUseDarkColors: false, on: mocks.themeOn },
  powerMonitor: { on: mocks.powerOn },
  screen: {
    on: mocks.screenOn,
    getAllDisplays: () => [{ size: { width: 1710, height: 1112 }, scaleFactor: 2 }],
  },
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { info: mocks.info, warn: mocks.warn, error: vi.fn() },
  redactUrlForLog: (url: string) => url.split(/[?#]/)[0],
  systemVersion: () => '26.1',
  uptimeMs: () => 5000,
}));
vi.mock('../../../src/main/diagnostics/log-retention', () => ({ scheduleDiagnosticPruning: mocks.scheduleDiagnosticPruning }));
vi.mock('../../../src/main/diagnostics/system-metrics', async (importOriginal) => ({
  aggregateProcessMetrics: (await importOriginal<typeof import('../../../src/main/diagnostics/system-metrics')>()).aggregateProcessMetrics,
  readRendererJsHeap: mocks.readRendererJsHeap,
}));
vi.mock('../../../src/main/app/ui-state', () => ({ isVibrancyEnabled: () => true, isLinuxNativeTitleBar: () => false }));
vi.mock('../../../src/main/window/window-registry', () => ({ getMainWindow: mocks.getMainWindow }));

import {
  bitmapStats,
  capturePageStats,
  describeDisplay,
  gpuFeatureSummary,
  installAppDiagnostics,
  logHealth,
  logRuntimeEnvironment,
  probePage,
  summarizeGpuInfo,
  withTimeout,
} from '../../../src/main/diagnostics/collector';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  mocks.info.mockClear();
  mocks.warn.mockClear();
  setPlatform('darwin');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('environment helpers', () => {
  it('describes displays compactly', () => {
    expect(describeDisplay({ size: { width: 2560, height: 1440 }, scaleFactor: 1 })).toBe('2560x1440@1x');
  });

  it('lists only GPU features that are not enabled', () => {
    expect(gpuFeatureSummary({ gpu_compositing: 'enabled', webgl: 'enabled_on' })).toBe('all-enabled');
    expect(gpuFeatureSummary({ gpu_compositing: 'disabled_software', webgl: 'enabled', webgpu: 'disabled_off' })).toBe(
      'gpu_compositing:disabled_software,webgpu:disabled_off',
    );
  });

  it('keeps the identifying GPU fields only', () => {
    expect(
      summarizeGpuInfo({
        gpuDevice: [{ active: true, vendorId: 4203, deviceId: 0, cudaCompatibilityMode: 1 }, 'bogus'],
        auxAttributes: { glRenderer: 'Apple M2', optimus: false },
        machineModelName: 'MacBookAir',
        machineModelVersion: '10.1',
      }),
    ).toEqual({
      devices: [{ active: true, vendorId: 4203, deviceId: 0 }],
      machineModel: 'MacBookAir 10.1',
      glRenderer: 'Apple M2',
    });
    expect(summarizeGpuInfo(undefined)).toEqual({ devices: [] });
  });

  it('resolves with a sentinel when the promise is too slow', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise(() => {}), 1_000);
      vi.advanceTimersByTime(1_000);
      expect(typeof (await pending)).toBe('symbol');
      expect(await withTimeout(Promise.resolve('fast'), 1_000)).toBe('fast');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bitmapStats', () => {
  it('reports the dominant color and how much of the frame it covers', () => {
    const pixels = [
      [0xff, 0xff, 0xff],
      [0xff, 0xff, 0xff],
      [0xff, 0xff, 0xff],
      [0x00, 0x00, 0xff],
    ];
    const bgra = Uint8Array.from(pixels.flatMap(([b, g, r]) => [b!, g!, r!, 0xff]));
    expect(bitmapStats(bgra, 2, 2, 3420, 2224)).toEqual({
      width: 3420,
      height: 2224,
      dominantColor: '#ffffff',
      dominantRatio: 0.75,
      distinctColors: 2,
    });
  });

  it('rejects empty or truncated bitmaps', () => {
    expect(bitmapStats(new Uint8Array(0), 0, 0)).toBeNull();
    expect(bitmapStats(new Uint8Array(4), 2, 2)).toBeNull();
  });
});

describe('logHealth', () => {
  it('summarizes main, UI renderer, all renderers and GPU memory', async () => {
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: { getOSProcessId: () => 77 } });
    await logHealth();
    const line = mocks.info.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\[health\] uptime=\d+m main_rss=\d+MB main_heap=\d+MB /);
    expect(line).toContain('ui_renderer=300MB ui_js_heap=120MB/4096MB renderers=2 renderers_total=400MB gpu=50MB');
  });

  it('marks values it could not read', async () => {
    mocks.getMainWindow.mockReturnValue(null);
    mocks.readRendererJsHeap.mockResolvedValueOnce(null);
    await logHealth();
    const line = mocks.info.mock.calls[0]?.[0] as string;
    expect(line).toContain('ui_renderer=?');
    expect(line).toContain('ui_js_heap=?');
  });
});

describe('logRuntimeEnvironment', () => {
  it('adds the native title bar setting on Linux only', () => {
    setPlatform('linux');
    logRuntimeEnvironment();
    expect(mocks.info).toHaveBeenLastCalledWith(
      '[env] locale=zh-CN system_locale=zh-Hans-CN theme=light vibrancy=on native_titlebar=off hw_accel=on displays=1(1710x1112@2x)',
    );
  });
});

describe('installAppDiagnostics', () => {
  it('logs the runtime environment and GPU, then follows power, display, theme and child-process events', async () => {
    installAppDiagnostics();
    installAppDiagnostics();

    expect(mocks.info.mock.calls[0]?.[0]).toBe(
      '[env] locale=zh-CN system_locale=zh-Hans-CN theme=light vibrancy=on hw_accel=on displays=1(1710x1112@2x)',
    );
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(
        '[gpu] {"devices":[{"active":true,"vendorId":4203,"deviceId":0}],"machineModel":"MacBookAir 10.1"}',
      ),
    );
    expect(mocks.scheduleDiagnosticPruning).toHaveBeenCalledOnce();

    mocks.info.mockClear();
    mocks.listeners.get('app:gpu-info-update')?.();
    mocks.listeners.get('app:gpu-info-update')?.();
    expect(mocks.info.mock.calls).toEqual([['[gpu] features=webgpu:disabled_off']]);
    gpuStatus.current = { gpu_compositing: 'disabled_software', webgpu: 'disabled_off' };
    mocks.listeners.get('app:gpu-info-update')?.();
    expect(mocks.info).toHaveBeenLastCalledWith('[gpu] features=gpu_compositing:disabled_software,webgpu:disabled_off');

    mocks.listeners.get('power:suspend')?.();
    mocks.listeners.get('power:resume')?.();
    mocks.listeners.get('screen:display-metrics-changed')?.({}, { size: { width: 1512, height: 982 }, scaleFactor: 2 }, ['workArea']);
    mocks.listeners.get('screen:display-metrics-changed')?.({}, { size: { width: 1512, height: 982 }, scaleFactor: 2 }, ['scaleFactor', 'workArea']);
    mocks.listeners.get('screen:display-removed')?.({}, { size: { width: 2560, height: 1440 }, scaleFactor: 1 });
    mocks.listeners.get('app:child-process-gone')?.({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });
    mocks.listeners.get('app:child-process-gone')?.({}, { type: 'GPU', reason: 'crashed', exitCode: 133 });
    mocks.listeners.get('app:child-process-gone')?.({}, { type: 'Utility', reason: 'oom', exitCode: 1, serviceName: 'network.mojom.NetworkService', name: 'Network Service' });

    expect(mocks.info).toHaveBeenCalledWith('[power] suspend');
    expect(mocks.info).toHaveBeenCalledWith('[power] resume');
    expect(mocks.info).toHaveBeenCalledWith('[display] changed 1512x982@2x metrics=scaleFactor');
    expect(mocks.info).not.toHaveBeenCalledWith(expect.stringContaining('metrics=workArea'));
    expect(mocks.info).toHaveBeenCalledWith('[display] removed 2560x1440@1x');
    expect(mocks.warn.mock.calls.map(([line]) => line)).toEqual([
      '[proc] child gone type=GPU reason=crashed exit_code=133',
      '[proc] child gone type=Utility reason=oom exit_code=1 service=network.mojom.NetworkService name=Network Service',
    ]);
  });
});

describe('page probes', () => {
  function contents(overrides: Record<string, unknown> = {}): never {
    return {
      isDestroyed: () => false,
      isCrashed: () => false,
      executeJavaScript: vi.fn(async () => ({ readyState: 'complete', appChildren: 0 })),
      capturePage: vi.fn(),
      ...overrides,
    } as never;
  }

  it('returns the page structure, or why it could not be read', async () => {
    expect(await probePage(contents())).toEqual({ readyState: 'complete', appChildren: 0 });
    expect(await probePage(contents({ isCrashed: () => true }))).toEqual({ error: 'crashed' });
    expect(await probePage(contents({ executeJavaScript: async () => { throw new Error('Script failed'); } }))).toEqual({
      error: 'Script failed',
    });
    expect(await probePage(contents({ executeJavaScript: async () => 'nope' }))).toEqual({ error: 'unexpected-result' });
  });

  it('samples a downscaled capture of the page', async () => {
    const sample = {
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Uint8Array.from([0x10, 0x20, 0x30, 0xff]),
    };
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(() => sample),
    };
    const page = contents({ capturePage: async () => image });
    expect(await capturePageStats(page)).toEqual({
      width: 1440,
      height: 900,
      dominantColor: '#332211',
      dominantRatio: 1,
      distinctColors: 1,
    });
    expect(image.resize).toHaveBeenCalledWith({ width: 64 });
    expect(await capturePageStats(contents({ capturePage: async () => ({ isEmpty: () => true }) }))).toEqual({ error: 'empty' });
    expect(await capturePageStats(contents({ isDestroyed: () => true }))).toEqual({ error: 'unavailable' });
  });
});
