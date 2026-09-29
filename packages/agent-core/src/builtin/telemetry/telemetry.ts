export type TelemetryPrimitive = string | number | boolean | null | undefined;

export type TelemetryProperties = Readonly<Record<string, TelemetryPrimitive>>;

export interface TelemetryContextPatch {
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly mode?: string;
  readonly provider_type?: string;
  readonly protocol?: string;
  readonly turn_id?: number;
  readonly trace_id?: string;
  readonly thinking_effort?: string;
  readonly model?: string;
}

export interface TelemetryAppenderRecord {
  readonly event: string;
  readonly context: TelemetryProperties;
  readonly properties: TelemetryProperties;
}

export interface TelemetryAppender {
  track(record: TelemetryAppenderRecord): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export const nullTelemetryAppender: TelemetryAppender = {
  track: () => {},
  flush: () => {},
  shutdown: () => {},
};

export type MutableTelemetryContext = Record<string, TelemetryPrimitive>;

export function applyTelemetryPatch(
  target: MutableTelemetryContext,
  patch: TelemetryContextPatch,
): MutableTelemetryContext {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
  return target;
}

const WIRE_SESSION_ID_PROPERTY = 'sessionId';

export function composeTelemetryProperties(
  ambient: TelemetryProperties,
  explicit: TelemetryProperties | undefined,
): TelemetryProperties {
  const properties: MutableTelemetryContext = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (key === 'session_id' || value === undefined) {
      continue;
    }
    properties[key] = value;
  }
  const sessionId = ambient['session_id'];
  if (sessionId !== undefined) {
    properties[WIRE_SESSION_ID_PROPERTY] = sessionId;
  }
  if (explicit !== undefined) {
    for (const [key, value] of Object.entries(explicit)) {
      if (value !== undefined) {
        properties[key] = value;
      }
    }
  }
  return properties;
}
