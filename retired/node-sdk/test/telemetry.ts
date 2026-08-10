import type { TelemetryClient, TelemetryProperties } from '#/index';

export interface TelemetryRecord {
  readonly event: string;
  readonly sessionId: string | null;
  readonly properties?: TelemetryProperties;
}

export function recordingTelemetry(records: TelemetryRecord[]): TelemetryClient {
  return {
    track: (event, properties) => {
      records.push({ event, sessionId: null, properties });
    },
    withContext: (patch) => ({
      track: (event, properties) => {
        records.push({ event, sessionId: patch.sessionId ?? null, properties });
      },
    }),
  };
}
