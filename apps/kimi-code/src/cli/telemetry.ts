import {
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';
import {
  KimiAuthFacade,
  loadRuntimeConfigSafe,
  log,
  resolveConfigPath,
  resolveKimiHome,
  type KimiConfig,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';

import type { PromptHarness } from './prompt-session';
import {
  initializeTelemetry,
  setTelemetryContext,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_USER_AGENT_PRODUCT, WEB_UI_MODE } from '#/constant/app';
import {
  currentKimiProfile,
  currentKimiRegionResolution,
  freshKimiProfile,
  resolveKimiRegionFresh,
} from '#/utils/region';

import { createKimiCodeHostIdentity } from './host-identity';

export interface CliTelemetryBootstrap {
  readonly homeDir: string;
  readonly deviceId: string;
  readonly firstLaunch: boolean;
}

export interface InitializeCliTelemetryOptions {
  readonly harness: PromptHarness;
  readonly bootstrap: CliTelemetryBootstrap;
  readonly config: Pick<KimiConfig, 'defaultModel' | 'telemetry'>;
  readonly version: string;
  readonly uiMode: string;
  readonly model?: string;
  readonly sessionId?: string;
}

export function createCliTelemetryBootstrap(): CliTelemetryBootstrap {
  let firstLaunch = false;
  const homeDir = resolveKimiHome();
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  return { homeDir, deviceId, firstLaunch };
}

export function initializeCliTelemetry(options: InitializeCliTelemetryOptions): void {
  const resolution = currentKimiRegionResolution();
  initializeTelemetry({
    homeDir: options.harness.homeDir,
    deviceId: options.bootstrap.deviceId,
    enabled: options.config.telemetry !== false,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: options.uiMode,
    model: options.model ?? options.config.defaultModel,
    sessionId: options.sessionId,
    region: resolution.region,
    regionSource: resolution.source,
    resolveRegion: () => currentKimiRegionResolution(),
    endpoint: () => currentKimiProfile().telemetryEndpoint,
    getAccessToken: async () =>
      (await options.harness.auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
    onUnexpectedError: (error) => log.warn('telemetry property dropped', { error: String(error) }),
  });
  if (options.bootstrap.firstLaunch) {
    options.harness.track('first_launch');
  }
}

export interface InitializeServerTelemetryOptions {
  readonly version: string;
}

export function initializeServerTelemetry(
  options: InitializeServerTelemetryOptions,
): TelemetryClient {
  const bootstrap = createCliTelemetryBootstrap();
  const configPath = resolveConfigPath({ homeDir: bootstrap.homeDir });
  const config = readServerTelemetryConfig(configPath);
  const auth = new KimiAuthFacade({
    homeDir: bootstrap.homeDir,
    configPath,
    identity: createKimiCodeHostIdentity(options.version),
  });

  const resolution = resolveKimiRegionFresh();
  initializeTelemetry({
    homeDir: bootstrap.homeDir,
    deviceId: bootstrap.deviceId,
    enabled: config.telemetry !== false,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: WEB_UI_MODE,
    model: config.defaultModel,
    region: resolution.region,
    regionSource: resolution.source,
    resolveRegion: () => currentKimiRegionResolution(),
    endpoint: () => freshKimiProfile().telemetryEndpoint,
    getAccessToken: async () => (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
    onUnexpectedError: (error) => log.warn('telemetry property dropped', { error: String(error) }),
  });

  return {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
}

function readServerTelemetryConfig(
  configPath: string,
): Pick<KimiConfig, 'telemetry' | 'defaultModel'> {
  try {
    const { config, fileError } = loadRuntimeConfigSafe(configPath);
    if (fileError !== undefined) return {};
    return config;
  } catch {
    return {};
  }
}
