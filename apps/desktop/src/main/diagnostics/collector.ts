import { cpus, freemem, release, totalmem } from 'node:os';

import { app, nativeTheme, powerMonitor, screen } from 'electron';
import type { Display, MemoryInfo, ProcessMetric, WebContents } from 'electron';

import { log, redactUrlForLog, systemVersion, uptimeMs } from './log';
import { scheduleDiagnosticPruning } from './log-retention';
import { releaseChannelName } from '../release/release-channel';
import { aggregateProcessMetrics, readRendererJsHeap } from './system-metrics';
import { isLinuxNativeTitleBar, isVibrancyEnabled } from '../app/ui-state';
import { getMainWindow } from '../window/main-window';

const MIB = 1024 * 1024;
const HEALTH_FIRST_SAMPLE_MS = 60_000;
const HEALTH_INTERVAL_MS = 10 * 60_000;
const GPU_INFO_TIMEOUT_MS = 5_000;
const GPU_FEATURES_FALLBACK_MS = 10_000;
const PAGE_PROBE_TIMEOUT_MS = 2_000;
const CAPTURE_TIMEOUT_MS = 3_000;
const CAPTURE_SAMPLE_WIDTH = 64;

const TIMED_OUT = Symbol('timed-out');

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mib(bytes: number | undefined): string {
  return bytes === undefined ? '?' : `${Math.round(bytes / MIB)}MB`;
}

export function describeDisplay(display: Pick<Display, 'size' | 'scaleFactor'>): string {
  return `${display.size.width}x${display.size.height}@${display.scaleFactor}x`;
}

export function gpuFeatureSummary(status: object): string {
  const degraded = Object.entries(status).filter(
    ([, value]) => typeof value === 'string' && !value.startsWith('enabled'),
  );
  if (degraded.length === 0) return 'all-enabled';
  return degraded.map(([feature, value]) => `${feature}:${String(value)}`).join(',');
}

export function summarizeGpuInfo(info: unknown): Record<string, unknown> {
  const record = isRecord(info) ? info : {};
  const devices = Array.isArray(record['gpuDevice']) ? record['gpuDevice'] : [];
  const keys = ['active', 'vendorId', 'deviceId', 'vendorString', 'deviceString', 'driverVendor', 'driverVersion'];
  const aux = record['auxAttributes'];
  const model = [record['machineModelName'], record['machineModelVersion']]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
  const summary: Record<string, unknown> = {
    devices: devices
      .filter(isRecord)
      .map((device) => Object.fromEntries(keys.filter((key) => device[key] !== undefined).map((key) => [key, device[key]]))),
  };
  if (model !== '') summary['machineModel'] = model;
  if (isRecord(aux) && typeof aux['glRenderer'] === 'string') summary['glRenderer'] = aux['glRenderer'];
  return summary;
}

export function logRuntimeEnvironment(): void {
  const displays = screen.getAllDisplays();
  log.info(
    [
      '[env]',
      `locale=${app.getLocale()}`,
      `system_locale=${app.getSystemLocale()}`,
      `theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`,
      `vibrancy=${isVibrancyEnabled() ? 'on' : 'off'}`,
      ...(process.platform === 'linux' ? [`native_titlebar=${isLinuxNativeTitleBar() ? 'on' : 'off'}`] : []),
      `hw_accel=${app.isHardwareAccelerationEnabled() ? 'on' : 'off'}`,
      `displays=${displays.length}(${displays.map(describeDisplay).join(',')})`,
    ].join(' '),
  );
}

let lastGpuFeatures: string | null = null;

function logGpuFeatures(): void {
  const summary = gpuFeatureSummary(app.getGPUFeatureStatus());
  if (summary === lastGpuFeatures) return;
  lastGpuFeatures = summary;
  log.info(`[gpu] features=${summary}`);
}

async function logGpuInfo(): Promise<void> {
  try {
    const info = await withTimeout(app.getGPUInfo('basic'), GPU_INFO_TIMEOUT_MS);
    if (info === TIMED_OUT) log.warn('[gpu] info timed out');
    else log.info(`[gpu] ${JSON.stringify(summarizeGpuInfo(info))}`);
  } catch (error) {
    log.warn(`[gpu] info unavailable: ${errorText(error)}`);
  }
}

function rendererPid(contents: WebContents): number | null {
  try {
    const pid = contents.getOSProcessId();
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processMemory(metric: ProcessMetric): MemoryInfo | undefined {
  return (metric as { memory?: MemoryInfo }).memory;
}

export async function logHealth(): Promise<void> {
  const memory = process.memoryUsage();
  const metrics = app.getAppMetrics();
  const processes = aggregateProcessMetrics(metrics);
  const win = getMainWindow();
  const mainPid = win === null || win.isDestroyed() ? null : rendererPid(win.webContents);
  const mainRenderer = mainPid === null ? undefined : metrics.find((metric) => metric.pid === mainPid);
  const mainRendererKb = mainRenderer === undefined ? undefined : processMemory(mainRenderer)?.workingSetSize;
  const heap = await readRendererJsHeap();
  log.info(
    [
      '[health]',
      `uptime=${Math.round(process.uptime() / 60)}m`,
      `main_rss=${mib(memory.rss)}`,
      `main_heap=${mib(memory.heapUsed)}`,
      `ui_renderer=${mib(mainRendererKb === undefined ? undefined : mainRendererKb * 1024)}`,
      `ui_js_heap=${heap === null ? '?' : `${mib(heap.used)}/${mib(heap.limit)}`}`,
      `renderers=${processes.renderer_process_count}`,
      `renderers_total=${mib(processes.renderer_working_set_bytes)}`,
      `gpu=${mib(processes.gpu_working_set_bytes)}`,
      `free_mem=${mib(freemem())}`,
    ].join(' '),
  );
}

function logHealthSafely(): void {
  void logHealth().catch((error: unknown) => {
    log.warn(`[health] sample failed: ${errorText(error)}`);
  });
}

function installSystemEventLogging(): void {
  powerMonitor.on('suspend', () => log.info('[power] suspend'));
  powerMonitor.on('resume', () => log.info('[power] resume'));
  powerMonitor.on('lock-screen', () => log.info('[power] lock-screen'));
  powerMonitor.on('unlock-screen', () => log.info('[power] unlock-screen'));
  screen.on('display-added', (_event, display) => log.info(`[display] added ${describeDisplay(display)}`));
  screen.on('display-removed', (_event, display) => log.info(`[display] removed ${describeDisplay(display)}`));
  screen.on('display-metrics-changed', (_event, display, changedMetrics) => {
    const relevant = changedMetrics.filter((metric) => metric !== 'workArea');
    if (relevant.length > 0) {
      log.info(`[display] changed ${describeDisplay(display)} metrics=${relevant.join(',')}`);
    }
  });
  nativeTheme.on('updated', () => {
    log.info(`[env] theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`);
  });
  app.on('gpu-info-update', logGpuFeatures);
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const labels = [
      `type=${details.type}`,
      `reason=${details.reason}`,
      `exit_code=${details.exitCode}`,
      ...(details.serviceName === undefined ? [] : [`service=${details.serviceName}`]),
      ...(details.name === undefined ? [] : [`name=${details.name}`]),
    ];
    log.warn(`[proc] child gone ${labels.join(' ')}`);
  });
}

let appDiagnosticsInstalled = false;

export function installAppDiagnostics(): void {
  if (appDiagnosticsInstalled) return;
  appDiagnosticsInstalled = true;
  try {
    logRuntimeEnvironment();
  } catch (error) {
    log.warn(`[env] unavailable: ${errorText(error)}`);
  }
  void logGpuInfo();
  installSystemEventLogging();
  const gpuFallback = setTimeout(logGpuFeatures, GPU_FEATURES_FALLBACK_MS);
  gpuFallback.unref?.();
  const firstSample = setTimeout(() => {
    logHealthSafely();
    const interval = setInterval(logHealthSafely, HEALTH_INTERVAL_MS);
    interval.unref?.();
  }, HEALTH_FIRST_SAMPLE_MS);
  firstSample.unref?.();
  scheduleDiagnosticPruning();
}

export const PAGE_PROBE_SCRIPT = `(() => {
  const describe = (element) => {
    if (!element) return null;
    const id = element.id ? '#' + element.id : '';
    const className = typeof element.className === 'string' ? element.className.trim() : '';
    return element.tagName.toLowerCase() + id + (className ? '.' + className.split(/\\s+/)[0] : '');
  };
  const samples = [];
  for (const y of [0.25, 0.5, 0.75]) {
    for (const x of [0.25, 0.5, 0.75]) {
      samples.push(describe(document.elementFromPoint(innerWidth * x, innerHeight * y)));
    }
  }
  const failed = performance.getEntriesByType('resource').filter(
    (entry) => typeof entry.responseStatus === 'number' && entry.responseStatus >= 400,
  );
  const isRequest = (entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest';
  const assetPath = (entry) => {
    try {
      return new URL(entry.name).pathname;
    } catch {
      return '?';
    }
  };
  const paint = performance.getEntriesByName('first-contentful-paint')[0];
  const root = document.getElementById('app');
  return {
    readyState: document.readyState,
    visibility: document.visibilityState,
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    htmlClass: document.documentElement.className,
    colorScheme: document.documentElement.dataset.colorScheme || null,
    bodyBackground: document.body ? getComputedStyle(document.body).backgroundColor : null,
    appChildren: root ? root.childElementCount : -1,
    globalLoading: document.querySelector('.gload') !== null,
    desktopBridge: typeof window.kimiDesktop === 'object' && window.kimiDesktop !== null,
    domNodes: document.getElementsByTagName('*').length,
    firstContentfulPaintMs: paint ? Math.round(paint.startTime) : null,
    failedAssets: failed.filter((entry) => !isRequest(entry)).slice(0, 20).map(assetPath),
    failedRequests: failed.filter(isRequest).length,
    samples,
  };
})()`;

export async function probePage(contents: WebContents): Promise<Record<string, unknown>> {
  if (contents.isDestroyed()) return { error: 'destroyed' };
  if (contents.isCrashed()) return { error: 'crashed' };
  try {
    const result: unknown = await withTimeout(contents.executeJavaScript(PAGE_PROBE_SCRIPT), PAGE_PROBE_TIMEOUT_MS);
    if (result === TIMED_OUT) return { error: 'timeout' };
    return isRecord(result) ? result : { error: 'unexpected-result' };
  } catch (error) {
    return { error: errorText(error) };
  }
}

export interface CaptureStats {
  width: number;
  height: number;
  dominantColor: string;
  dominantRatio: number;
  distinctColors: number;
}

function expandNibble(value: number): string {
  return ((value << 4) | value).toString(16).padStart(2, '0');
}

export function bitmapStats(
  bgra: Uint8Array,
  sampleWidth: number,
  sampleHeight: number,
  width: number = sampleWidth,
  height: number = sampleHeight,
): CaptureStats | null {
  const pixels = sampleWidth * sampleHeight;
  if (pixels === 0 || bgra.length < pixels * 4) return null;
  const counts = new Map<number, number>();
  for (let offset = 0; offset < pixels * 4; offset += 4) {
    const blue = (bgra[offset] ?? 0) >> 4;
    const green = (bgra[offset + 1] ?? 0) >> 4;
    const red = (bgra[offset + 2] ?? 0) >> 4;
    const key = (red << 8) | (green << 4) | blue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of counts) {
    if (count > dominantCount) {
      dominantKey = key;
      dominantCount = count;
    }
  }
  return {
    width,
    height,
    dominantColor: `#${expandNibble(dominantKey >> 8)}${expandNibble((dominantKey >> 4) & 0xf)}${expandNibble(dominantKey & 0xf)}`,
    dominantRatio: Math.round((dominantCount / pixels) * 1000) / 1000,
    distinctColors: counts.size,
  };
}

export async function capturePageStats(contents: WebContents): Promise<CaptureStats | { error: string }> {
  if (contents.isDestroyed() || contents.isCrashed()) return { error: 'unavailable' };
  try {
    const image = await withTimeout(contents.capturePage(), CAPTURE_TIMEOUT_MS);
    if (image === TIMED_OUT) return { error: 'timeout' };
    if (image.isEmpty()) return { error: 'empty' };
    const size = image.getSize();
    const sample = image.resize({ width: Math.min(CAPTURE_SAMPLE_WIDTH, size.width) });
    const sampleSize = sample.getSize();
    return bitmapStats(sample.toBitmap(), sampleSize.width, sampleSize.height, size.width, size.height) ?? { error: 'empty' };
  } catch (error) {
    return { error: errorText(error) };
  }
}

export function describeProcesses(): Record<string, unknown>[] {
  return app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    name: metric.name ?? null,
    serviceName: metric.serviceName ?? null,
    cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
    workingSetKb: processMemory(metric)?.workingSetSize ?? null,
    peakWorkingSetKb: processMemory(metric)?.peakWorkingSetSize ?? null,
    creationTime: metric.creationTime,
  }));
}

async function completeGpuInfo(): Promise<unknown> {
  try {
    const info = await withTimeout(app.getGPUInfo('complete'), GPU_INFO_TIMEOUT_MS);
    return info === TIMED_OUT ? { error: 'timeout' } : info;
  } catch (error) {
    return { error: errorText(error) };
  }
}

function describeMainWindow(): Record<string, unknown> | null {
  const win = getMainWindow();
  if (win === null || win.isDestroyed()) return null;
  const contents = win.webContents;
  const live = !contents.isDestroyed();
  return {
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    fullScreen: win.isFullScreen(),
    bounds: win.getBounds(),
    url: live ? redactUrlForLog(contents.getURL()) : null,
    loading: live ? contents.isLoading() : null,
    crashed: live ? contents.isCrashed() : null,
    rendererPid: live ? rendererPid(contents) : null,
    zoomFactor: live ? contents.getZoomFactor() : null,
  };
}

export async function collectDiagnosticsSnapshot(): Promise<Record<string, unknown>> {
  const win = getMainWindow();
  const contents = win === null || win.isDestroyed() || win.webContents.isDestroyed() ? null : win.webContents;
  const [gpuInfo, page, screenshot] = await Promise.all([
    completeGpuInfo(),
    contents === null ? Promise.resolve({ error: 'no-window' }) : probePage(contents),
    contents === null ? Promise.resolve({ error: 'no-window' }) : capturePageStats(contents),
  ]);
  const version = app.getVersion();
  const cpuList = cpus();
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version,
      channel: releaseChannelName(version, app.isPackaged),
      packaged: app.isPackaged,
      pid: process.pid,
      uptimeMs: uptimeMs(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      locale: app.getLocale(),
      systemLocale: app.getSystemLocale(),
    },
    os: {
      platform: process.platform,
      systemVersion: systemVersion(),
      kernel: release(),
      arch: process.arch,
      cpuModel: cpuList[0]?.model.trim() ?? null,
      cpus: cpuList.length,
      totalMemBytes: totalmem(),
      freeMemBytes: freemem(),
    },
    gpu: {
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      featureStatus: app.getGPUFeatureStatus(),
      info: gpuInfo,
    },
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      size: display.size,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal,
    })),
    settings: {
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      themeSource: nativeTheme.themeSource,
      vibrancy: isVibrancyEnabled(),
      linuxNativeTitleBar: process.platform === 'linux' ? isLinuxNativeTitleBar() : null,
    },
    processes: describeProcesses(),
    mainWindow: describeMainWindow(),
    page,
    screenshot,
  };
}
