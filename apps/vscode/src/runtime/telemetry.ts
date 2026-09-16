import {
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
  kimiRegionProfile,
  resolveKimiRegion,
  type KimiRegion,
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
// Same managed-provider slot the CLI reads (apps/kimi-code/src/utils/region.ts).
const MANAGED_PROVIDER_KEY = "managed:kimi-code";

export interface VscodeTelemetryOptions {
  readonly homeDir?: string;
  readonly version: string;
  readonly log?: (message: string) => void;
  /**
   * Editor-level telemetry gate (VS Code's global Telemetry Level).
   * Undefined means the gate is not consulted (tests, non-editor hosts).
   */
  readonly isEditorTelemetryEnabled?: () => boolean;
  /** Editor gate change hook; re-initializes the pipeline when it fires. */
  readonly onEditorTelemetryChange?: (listener: (enabled: boolean) => void) => void;
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
  // Both gates must pass: the Kimi config toggle and the editor-level
  // Telemetry Level. `enabled` is false only on an explicit opt-out.
  const configEnabled = readTelemetryEnabled(resolveConfigPath({ homeDir }));
  let editorEnabled = options.isEditorTelemetryEnabled?.() ?? true;
  const boot = (): void =>
    initializeTelemetry({
      homeDir,
      deviceId,
      enabled: configEnabled === false || !editorEnabled ? false : undefined,
      appName: VSCODE_TELEMETRY_APP_NAME,
      version: options.version,
      uiMode: VSCODE_TELEMETRY_UI_MODE,
      endpoint: () => kimiRegionProfile(resolveVscodeTelemetryRegion(homeDir)).telemetryEndpoint,
      getAccessToken: async () =>
        auth === undefined
          ? null
          : (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
      onUnexpectedError: (error) => options.log?.(`telemetry property dropped: ${String(error)}`),
    });
  boot();
  // Toggling the editor setting must not strand the old pipeline: a fresh
  // initialize either disables the singleton outright or reattaches a sink,
  // stopping the previous periodic flush.
  options.onEditorTelemetryChange?.((enabled) => {
    editorEnabled = enabled;
    boot();
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

/**
 * Region for the telemetry endpoint. Follows the CLI helper: the persisted
 * login's oauth ref (credential key + oauthHost) wins over the install
 * marker, so a user who switched regions still reports to the deployment
 * their credentials belong to.
 */
export function resolveVscodeTelemetryRegion(homeDir: string): KimiRegion {
  const oauth = loadRuntimeConfigSafe(resolveConfigPath({ homeDir })).config.providers?.[
    MANAGED_PROVIDER_KEY
  ]?.oauth;
  return resolveKimiRegion({
    homeDir,
    configuredOAuthHost: oauth?.oauthHost,
    configuredOAuthKey: oauth?.key,
  });
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
