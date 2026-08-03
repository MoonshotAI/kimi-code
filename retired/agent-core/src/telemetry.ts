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

export function withTelemetryProperties(
  telemetry: TelemetryClient,
  defaults: TelemetryProperties,
): TelemetryClient {
  return {
    track(event, properties) {
      telemetry.track(event, { ...defaults, ...properties });
    },
    withContext(patch) {
      return withTelemetryProperties(withTelemetryContext(telemetry, patch), defaults);
    },
    setContext(patch) {
      telemetry.setContext?.(patch);
    },
  };
}
