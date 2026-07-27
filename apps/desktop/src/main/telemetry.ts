import {
  createCloudAppender,
  IConfigService,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { DESKTOP_PRODUCT_NAME, DESKTOP_UI_MODE } from '../shared/identity';
import { log } from './log';
import { setDesktopTrackImpl } from './track';

export interface DesktopTelemetryHandle {
  /** Emits `exit`, flushes the buffer, stops periodic flush. Idempotent. */
  readonly shutdown: () => Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const DISABLE_ENV = 'KIMI_DISABLE_TELEMETRY';
// Same truthy set as the v1 telemetry package (packages/telemetry in
// kimi-code) — the v2 pipeline never reads this env, so the desktop host
// checks it itself to keep the killswitch working.
const TRUE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

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
export async function wireDesktopTelemetry(core: Scope): Promise<DesktopTelemetryHandle | null> {
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
    let firstLaunch = false;
    const deviceId = createKimiDeviceId(resolveKimiHome(), {
      onFirstLaunch: () => {
        firstLaunch = true;
      },
    });
    const auth = core.accessor.get(IOAuthToolkit);
    // Install before the renderer creates any session: session_started fires
    // inside session create/resume, and a late appender drops those events.
    const appender = createCloudAppender(core.accessor, {
      deviceId,
      appName: DESKTOP_PRODUCT_NAME,
      uiMode: DESKTOP_UI_MODE,
      getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
    });
    telemetry.setAppender(appender);
    setDesktopTrackImpl((event, properties) => {
      telemetry.track(event, properties);
    });
    appender.startPeriodicFlush();
    void appender.retryDiskEvents().catch(() => {});
    if (firstLaunch) {
      telemetry.track2('first_launch');
    }
    log.info('[kimi-desktop] telemetry wired (cloud appender)');

    let shutdownOnce: Promise<void> | undefined;
    return {
      shutdown: () =>
        (shutdownOnce ??= (async () => {
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
