export type TelemetryPrimitive = boolean | number | string | undefined | null;
export type TelemetryProperties = Record<string, TelemetryPrimitive>;
export type TelemetryContext = Record<string, TelemetryPrimitive>;

const MAX_TELEMETRY_NUMBER_MAGNITUDE = Number.MAX_SAFE_INTEGER;

export interface TelemetryEvent {
  readonly event_id: string;
  device_id: string | null;
  session_id: string | null;
  readonly event: string;
  readonly timestamp: number;
  readonly properties: TelemetryProperties;
}

export interface EnrichedTelemetryEvent extends TelemetryEvent {
  readonly context: TelemetryContext;
}

export interface TelemetryTransport {
  send(events: readonly EnrichedTelemetryEvent[], signal?: AbortSignal): Promise<void>;
  saveToDisk(events: readonly EnrichedTelemetryEvent[]): void;
  retryDiskEvents(): Promise<void>;
}

export function isTelemetryPrimitive(value: unknown): value is TelemetryPrimitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && isTelemetryNumber(value))
  );
}

function isTelemetryNumber(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_TELEMETRY_NUMBER_MAGNITUDE;
}
