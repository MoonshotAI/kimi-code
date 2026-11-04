import * as vscode from "vscode";

import {
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
  KIMI_REGION_PROFILES,
} from "@moonshot-ai/kimi-code-oauth";
import {
  KimiAuthFacade,
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
  type KimiConfig,
} from "@moonshot-ai/kimi-code-sdk";
import {
  initializeTelemetry,
  setTelemetryEnabled,
  shouldEnableTelemetry,
  shutdownTelemetry,
  track,
} from "@moonshot-ai/kimi-telemetry";

import { resolveExtensionRegion } from "./utils/region";

const SHUTDOWN_TIMEOUT_MS = 2000;

export interface ExtensionTelemetryOptions {
  readonly version: string;
  readonly log: (message: string) => void;
}

export function activateExtensionTelemetry(options: ExtensionTelemetryOptions): vscode.Disposable {
  const homeDir = resolveKimiHome();
  let firstLaunch = false;
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  const configPath = resolveConfigPath({ homeDir });
  const config = readTelemetryConfig(configPath);
  const auth = new KimiAuthFacade({ homeDir, configPath });
  const resolveRegion = () => resolveExtensionRegion({ homeDir });
  const resolution = resolveRegion();

  initializeTelemetry({
    homeDir,
    deviceId,
    enabled: config.telemetry !== false,
    initiallyEnabled: vscode.env.isTelemetryEnabled,
    appName: "kimi-code-vscode",
    version: options.version,
    uiMode: "vscode",
    model: config.defaultModel,
    region: resolution.region,
    regionSource: resolution.source,
    resolveRegion,
    endpoint: () => KIMI_REGION_PROFILES[resolveRegion().region].telemetryEndpoint,
    getAccessToken: async () => (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
    onUnexpectedError: (error) => options.log(`Telemetry dropped a property: ${error.message}`),
  });

  const staticallyEnabled = shouldEnableTelemetry({ enabled: config.telemetry !== false });
  if (firstLaunch) track("first_launch");

  return vscode.env.onDidChangeTelemetryEnabled((enabled) => {
    if (staticallyEnabled) setTelemetryEnabled(enabled);
  });
}

export async function deactivateExtensionTelemetry(): Promise<void> {
  await shutdownTelemetry({ timeoutMs: SHUTDOWN_TIMEOUT_MS });
}

function readTelemetryConfig(
  configPath: string,
): Pick<KimiConfig, "telemetry" | "defaultModel"> {
  try {
    const { config, fileError } = loadRuntimeConfigSafe(configPath);
    if (fileError !== undefined) return {};
    return config;
  } catch {
    return {};
  }
}
