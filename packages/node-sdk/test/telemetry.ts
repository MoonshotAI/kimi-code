import type { TelemetryClient, TelemetryProperties } from '#/index';

export interface TelemetryRecord {
  readonly event: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly properties?: TelemetryProperties;
}

export function recordingTelemetry(records: TelemetryRecord[]): TelemetryClient {
  const scoped = (sessionId: string | null, model: string | null): TelemetryClient => ({
    track: (event, properties) => {
      records.push({ event, sessionId, model, properties });
    },
    withContext: (patch) => scoped(patch.sessionId ?? sessionId, patch.model ?? model),
  });
  return {
    track: (event, properties) => {
      records.push({ event, sessionId: null, model: null, properties });
    },
    withContext: (patch) => scoped(patch.sessionId ?? null, patch.model ?? null),
  };
}
