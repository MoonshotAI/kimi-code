export type TelemetryPrimitive = string | number | boolean | null | undefined;

export type TelemetryProperties = Readonly<Record<string, TelemetryPrimitive>>;

export interface SessionTelemetryContext {
  readonly session_id: string;
}

export interface AgentTelemetryContext {
  readonly agent_id: string;
  readonly mode: 'agent' | 'plan';
  readonly provider_type?: string;
  readonly protocol?: string;
}

export interface TurnTelemetryContext {
  readonly turn_id?: number;
  readonly trace_id?: string;
  readonly thinking_effort?: string;
}

export interface TelemetryContextPatch
  extends Partial<SessionTelemetryContext>,
    Partial<AgentTelemetryContext>,
    Partial<TurnTelemetryContext> {
  readonly model?: string;
}
