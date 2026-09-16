import {
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
  kimiRegionProfile,
  resolveKimiRegion,
} from "@moonshot-ai/kimi-code-oauth";
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
  type KimiAuthFacade,
  type TelemetryClient,
} from "@moonshot-ai/kimi-code-sdk";
import {
  initializeTelemetry,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from "@moonshot-ai/kimi-telemetry";

/**
 * Client-side telemetry for the extension host. Mirrors the CLI/web bootstrap
 * (`initializeCliTelemetry` / `initializeServerTelemetry` in apps/kimi-code):
 * the shared `@moonshot-ai/kimi-telemetry` pipeline buffers kfc events and
 * flushes them to the region telemetry endpoint, tagging every row with
 * `ui_mode: "vscode"` so extension usage shows up in the existing pipeline.
 */

const VSCODE_TELEMETRY_APP_NAME = "kimi-code-vscode";
const VSCODE_TELEMETRY_UI_MODE = "vscode";
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 3_000;

export interface VscodeTelemetryOptions {
  readonly homeDir?: string;
  readonly version: string;
  readonly log?: (message: string) => void;
}

export interface VscodeTelemetry {
  readonly client: TelemetryClient;
  /** The resolved Kimi home backing both the device id and the harness. */
  readonly homeDir: string;
  /** Supplies the OAuth facade once the harness (and its auth) exists. */
  bindAuth(auth: KimiAuthFacade): void;
  shutdown(): Promise<void>;
}

export function initializeVscodeTelemetry(options: VscodeTelemetryOptions): VscodeTelemetry {
  const homeDir = resolveKimiHome(options.homeDir);
  const deviceId = createKimiDeviceId(homeDir);
  // The auth facade only exists after the harness is built; flushes always
  // happen on timers, well after the binding, so a deferred lookup is enough.
  let auth: KimiAuthFacade | undefined;
  initializeTelemetry({
    homeDir,
    deviceId,
    enabled: readTelemetryEnabled(resolveConfigPath({ homeDir })),
    appName: VSCODE_TELEMETRY_APP_NAME,
    version: options.version,
    uiMode: VSCODE_TELEMETRY_UI_MODE,
    endpoint: () => kimiRegionProfile(resolveKimiRegion({ homeDir })).telemetryEndpoint,
    getAccessToken: async () =>
      auth === undefined ? null : (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
    onUnexpectedError: (error) => options.log?.(`telemetry property dropped: ${String(error)}`),
  });
  return {
    client: {
      track,
      withContext: withTelemetryContext,
      setContext: setTelemetryContext,
    },
    homeDir,
    bindAuth: (facade) => {
      auth = facade;
    },
    shutdown: () => shutdownTelemetry({ timeoutMs: TELEMETRY_SHUTDOWN_TIMEOUT_MS }),
  };
}

/** Honors the user's `telemetry` config toggle; a broken config leaves it on. */
function readTelemetryEnabled(configPath: string): boolean | undefined {
  try {
    const { config, fileError } = loadRuntimeConfigSafe(configPath);
    if (fileError !== undefined) return undefined;
    return config.telemetry ?? undefined;
  } catch {
    return undefined;
  }
}
