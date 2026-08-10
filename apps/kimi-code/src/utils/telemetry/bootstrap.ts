import { getDefaultTelemetryClient } from './client';
import { EventSink } from './sink';
import { SystemMetricsCollector } from './systemMetrics';
import { AsyncTransport } from './transport';

export const TELEMETRY_DISABLE_ENV = 'KIMI_DISABLE_TELEMETRY';

const TRUE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

export interface TelemetryBootstrapOptions {
  readonly enabled?: boolean;
  readonly homeDir: string;
  readonly deviceId: string;
  readonly sessionId?: string;
  readonly appName: string;
  readonly version: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
}

export function isTelemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[TELEMETRY_DISABLE_ENV];
  return value !== undefined && TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

export function shouldEnableTelemetry(
  input: { readonly enabled?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): boolean {
  return input.enabled !== false && !isTelemetryDisabledByEnv(input.env ?? process.env);
}

export function initializeTelemetry(options: TelemetryBootstrapOptions): void {
  const client = getDefaultTelemetryClient();
  if (!shouldEnableTelemetry({ enabled: options.enabled })) {
    client.disable();
    return;
  }

  client.enable();
  client.setContext({
    deviceId: options.deviceId,
    sessionId: options.sessionId,
  });

  const transport = new AsyncTransport({
    homeDir: options.homeDir,
    deviceId: options.deviceId,
    getAccessToken: options.getAccessToken,
  });
  const sink = new EventSink({
    transport,
    context: {
      appName: options.appName,
      version: options.version,
      uiMode: options.uiMode,
      model: options.model,
      buildSha: options.buildSha,
      terminal: options.terminal,
      locale: options.locale,
    },
  });

  client.attachSink(sink);
  sink.startPeriodicFlush();

  const systemMetricsCollector = new SystemMetricsCollector({ client });
  client.setSystemMetricsCollector(systemMetricsCollector);
  systemMetricsCollector.start();

  void sink.retryDiskEvents().catch(() => {});
}
