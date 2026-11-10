export type TelemetryPropertyValue = boolean | number | string | undefined | null;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export interface TelemetryContextPatch {
  readonly sessionId?: string | null;
}

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  setContext?(patch: TelemetryContextPatch): void;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  withContext: () => noopTelemetryClient,
  setContext: () => {},
};

export function withTelemetryContext(
  telemetry: TelemetryClient,
  patch: TelemetryContextPatch,
): TelemetryClient {
  return telemetry.withContext?.(patch) ?? telemetry;
}
