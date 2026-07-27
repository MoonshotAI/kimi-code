/**
 * Server telemetry bootstrap — wires agent-core-v2's `CloudAppender` into the
 * App-scoped `ITelemetryService` so engine events emitted inside the server
 * process (`session_started`, turn / tool / permission events, `image_compress`,
 * …) actually leave the process. Mirrors the v1 `kimi web` host
 * (`initializeServerTelemetry` in apps/kimi-code): same product app name, the
 * surface distinguished by `ui_mode = "web"`, the config `telemetry` toggle
 * honored at startup (a change takes effect on restart).
 */

import {
  type CloudAppender,
  createCloudAppender,
  IConfigService,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';

// Same product as the CLI; the surface is distinguished by ui_mode (v1
// convention: CLI_USER_AGENT_PRODUCT / WEB_UI_MODE in apps/kimi-code).
const SERVER_TELEMETRY_APP_NAME = 'kimi-code-cli';
const SERVER_TELEMETRY_UI_MODE = 'web';

/**
 * Cap on the final flush during server close. A wedged telemetry endpoint must
 * not hold shutdown hostage; whatever remains unsent is persisted by the
 * transport's disk layer.
 */
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ServerTelemetry {
  readonly service: ITelemetryService;
  /** Present only when telemetry is enabled (config `telemetry` !== false). */
  readonly appender?: CloudAppender;
}

export async function initializeServerTelemetry(
  core: Scope,
  homeDir: string,
): Promise<ServerTelemetry> {
  const service = core.accessor.get(ITelemetryService);
  const config = core.accessor.get(IConfigService);
  await config.ready;
  let enabled = true;
  try {
    enabled = config.get('telemetry') !== false;
  } catch {
    enabled = true;
  }
  if (!enabled) return { service };

  const auth = core.accessor.get(IOAuthToolkit);
  const appender = createCloudAppender(core.accessor, {
    deviceId: createKimiDeviceId(homeDir),
    appName: SERVER_TELEMETRY_APP_NAME,
    uiMode: SERVER_TELEMETRY_UI_MODE,
    model: config.get<string>('defaultModel') ?? undefined,
    getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
  });
  service.setAppender(appender);
  // The server is long-lived: flush on a timer, not only at the threshold.
  appender.startPeriodicFlush();
  return { service, appender };
}

export async function shutdownServerTelemetry(telemetry: ServerTelemetry): Promise<void> {
  await Promise.race([
    telemetry.service.shutdown(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TELEMETRY_SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}
