import {
  type CloudAppender,
  createCloudAppender,
  IBootstrapService,
  IConfigService,
  type IDisposable,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';

const SERVER_TELEMETRY_APP_NAME = 'kimi-code-cli';
const SERVER_TELEMETRY_UI_MODE = 'web';
const TELEMETRY_DISABLE_ENV = 'KIMI_DISABLE_TELEMETRY';
const TELEMETRY_DISABLE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ServerTelemetry {
  readonly appender?: CloudAppender;
  readonly registration?: IDisposable;
}

export function isEnvFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && TELEMETRY_DISABLE_ENV_VALUES.has(value.trim().toLowerCase());
}

export function isServerTelemetryDisabled(core: Scope): boolean {
  if (core.accessor.get(IConfigService).get('telemetry') === false) return true;
  return isEnvFlagEnabled(core.accessor.get(IBootstrapService).getEnv(TELEMETRY_DISABLE_ENV));
}

export async function initializeServerTelemetry(
  core: Scope,
  homeDir: string,
): Promise<ServerTelemetry> {
  const service = core.accessor.get(ITelemetryService);
  const config = core.accessor.get(IConfigService);
  await config.ready;
  if (isServerTelemetryDisabled(core)) return {};

  const auth = core.accessor.get(IOAuthToolkit);
  const appender = createCloudAppender(core.accessor, {
    deviceId: createKimiDeviceId(homeDir),
    appName: SERVER_TELEMETRY_APP_NAME,
    uiMode: SERVER_TELEMETRY_UI_MODE,
    model: config.get<string>('defaultModel') ?? undefined,
    getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
  });
  const registration = service.addAppender(appender);
  try {
    appender.startPeriodicFlush();
  } catch (error) {
    registration.dispose();
    throw error;
  }
  return { appender, registration };
}

export async function shutdownServerTelemetry(
  telemetry: ServerTelemetry,
  deadlineMs = Date.now() + TELEMETRY_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  telemetry.registration?.dispose();
  if (telemetry.appender === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      telemetry.appender.shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
