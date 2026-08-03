import type { TelemetryClient, TelemetryProperties } from '../../src/telemetry';

export interface TelemetryRecord {
  readonly event: string;
  readonly properties?: TelemetryProperties;
}

export interface TelemetryContextRecord extends TelemetryRecord {
  readonly sessionId: string | null;
}

export function recordingTelemetry(records: TelemetryRecord[]): TelemetryClient {
  return {
    track: (event, properties) => {
      records.push({ event, properties });
    },
    withContext: () => recordingTelemetry(records),
  };
}

export function recordingContextTelemetry(records: TelemetryContextRecord[]): TelemetryClient {
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
