import { statSync } from 'node:fs';
import { join } from 'node:path';

import { nativeTheme } from 'electron';
import {
  createCloudAppender,
  IConfigService,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
  type TelemetryProperties,
} from '@moonshot-ai/agent-core-v2';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { DESKTOP_PRODUCT_NAME, DESKTOP_UI_MODE } from '../shared/identity';
import { log } from './log';
import { getRuntimeLocale, getServerMode } from './runtime-context';
import { startDesktopSystemMetrics, stopDesktopSystemMetrics } from './system-metrics';
import { setDesktopTrackImpl } from './track';

export interface DesktopTelemetryHandle {
  /** Emits `exit`, flushes the buffer, stops periodic flush. Idempotent. */
  readonly shutdown: () => Promise<void>;
}

export interface DesktopTelemetryIdentity {
  readonly deviceId: string;
  readonly firstLaunch: boolean;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const DISABLE_ENV = 'KIMI_DISABLE_TELEMETRY';
// Same truthy set as the v1 telemetry package (packages/telemetry in
// kimi-code) — the v2 pipeline never reads this env, so the desktop host
// checks it itself to keep the killswitch working.
const TRUE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

const DAY_MS = 86_400_000;

export function daysSince(birthtimeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - birthtimeMs) / DAY_MS));
}

// Install age is the device_id file's birth time (oauth identity.ts creates
// it on first launch). Undefined when unreadable — the field is dropped.
function readDaysSinceInstall(): number | undefined {
  try {
    return daysSince(statSync(join(resolveKimiHome(), 'device_id')).birthtimeMs, Date.now());
  } catch {
    return undefined;
  }
}

// Super properties merged into every desktop event. Undefined values are
// dropped; event-own fields always win the merge.
function withSuperProperties(
  startedAt: number,
  daysSinceInstall: number | undefined,
  properties: TelemetryProperties | undefined,
): TelemetryProperties {
  const injected: Record<string, string | number> = {
    app_uptime_ms: Date.now() - startedAt,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  };
  const serverMode = getServerMode();
  if (serverMode !== undefined) injected['server_mode'] = serverMode;
  if (daysSinceInstall !== undefined) injected['days_since_install'] = daysSinceInstall;
  const locale = getRuntimeLocale();
  if (locale !== undefined) injected['locale'] = locale;
  return { ...injected, ...properties };
}

export function isTelemetryConsentEnabled(
  configValue: unknown,
  envValue: string | undefined,
): boolean {
  if (envValue !== undefined && TRUE_ENV_VALUES.has(envValue.trim().toLowerCase())) {
    return false;
  }
  return configValue !== false;
}

/**
 * Attach agent-core-v2's CloudAppender to the embedded server's telemetry
 * service. kap-server wires no appender itself, so without this every event
 * falls into the null appender. Consent is the host's job: the config
 * `telemetry` key (opt-out, the same key the settings privacy toggle writes)
 * plus the KIMI_DISABLE_TELEMETRY env. Returns null when consent denies or
 * wiring fails — telemetry must never break server startup.
 */
export async function wireDesktopTelemetry(
  core: Scope,
  identity: DesktopTelemetryIdentity,
): Promise<DesktopTelemetryHandle | null> {
  try {
    const configService = core.accessor.get(IConfigService);
    await configService.ready;
    let configValue: unknown;
    try {
      configValue = configService.get('telemetry');
    } catch {
      configValue = undefined;
    }
    if (!isTelemetryConsentEnabled(configValue, process.env[DISABLE_ENV])) {
      log.info('[kimi-desktop] telemetry disabled by config or env');
      return null;
    }

    const telemetry = core.accessor.get(ITelemetryService);
    const startedAt = Date.now();
    const auth = core.accessor.get(IOAuthToolkit);
    // Install before the renderer creates any session: session_started fires
    // inside session create/resume, and a late appender drops those events.
    const appender = createCloudAppender(core.accessor, {
      deviceId: identity.deviceId,
      appName: DESKTOP_PRODUCT_NAME,
      uiMode: DESKTOP_UI_MODE,
      getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
    });
    telemetry.setAppender(appender);
    const daysSinceInstall = readDaysSinceInstall();
    setDesktopTrackImpl((event, properties) => {
      telemetry.track(event, withSuperProperties(startedAt, daysSinceInstall, properties));
    });
    appender.startPeriodicFlush();
    void appender.retryDiskEvents().catch(() => {});
    startDesktopSystemMetrics();
    if (identity.firstLaunch) {
      telemetry.track2('first_launch');
    }
    log.info('[kimi-desktop] telemetry wired (cloud appender)');

    let shutdownOnce: Promise<void> | undefined;
    return {
      shutdown: () =>
        (shutdownOnce ??= (async () => {
          stopDesktopSystemMetrics();
          telemetry.track2('exit', { duration_ms: Date.now() - startedAt });
          appender.stopPeriodicFlush();
          await raceTimeout(telemetry.shutdown(), SHUTDOWN_TIMEOUT_MS);
          setDesktopTrackImpl(null);
        })()),
    };
  } catch (error) {
    log.error(
      `[kimi-desktop] telemetry wiring failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function raceTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Best-effort flush on quit; the transport's disk fallback re-sends the
    // buffered events on the next launch.
  } finally {
    clearTimeout(timer);
  }
}
