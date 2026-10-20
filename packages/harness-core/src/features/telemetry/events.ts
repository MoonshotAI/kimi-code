import { createCollection, useContribute } from '@moonshot-ai/agent-core/kernel/index';

import type { TelemetryFace } from './feature';
import type { TelemetryPrimitive, TelemetryProperties } from './telemetry';

export interface TelemetryEventDefinition {
  readonly name: string;
  readonly properties?: readonly string[];
}

export const TelemetryEvents = createCollection<TelemetryEventDefinition>('telemetry.events');

export function useTelemetryEvents(defs: readonly TelemetryEventDefinition[]): void {
  for (const def of defs) {
    useContribute(TelemetryEvents, def);
  }
}

type DefinitionProps<D extends readonly TelemetryEventDefinition[], N extends string> =
  Extract<D[number], { readonly name: N }> extends infer Def
    ? Def extends { readonly properties: infer P extends readonly string[] }
      ? P[number]
      : never
    : never;

export type TelemetryTracker<D extends readonly TelemetryEventDefinition[]> = <
  N extends D[number]['name'],
>(
  event: N,
  ...args: [DefinitionProps<D, N>] extends [never]
    ? [properties?: TelemetryProperties]
    : [properties: { [K in DefinitionProps<D, N>]: TelemetryPrimitive }]
) => void;

export function createTracker<const D extends readonly TelemetryEventDefinition[]>(
  telemetry: TelemetryFace,
  defs: D,
): TelemetryTracker<D> {
  const known = new Set(defs.map((def) => def.name));
  return ((event: string, properties?: TelemetryProperties) => {
    if (!known.has(event)) {
      throw new Error(`unknown telemetry event '${event}'`);
    }
    telemetry.track(event, properties);
  }) as TelemetryTracker<D>;
}

export const machineTelemetryEvents = [
  { name: 'turn_started', properties: ['turn_id'] },
  { name: 'turn_interrupted', properties: ['turn_id', 'at_step', 'interrupt_reason'] },
  { name: 'turn_ended', properties: ['turn_id', 'reason', 'duration_ms'] },
  {
    name: 'tool_call',
    properties: ['turn_id', 'tool_call_id', 'tool_name', 'outcome', 'duration_ms', 'error_type'],
  },
  { name: 'api_error', properties: ['error_type', 'model'] },
  {
    name: 'prompt_cache_probe',
    properties: ['turn_id', 'input_tokens', 'input_cache_read', 'input_cache_creation', 'output_tokens'],
  },
  { name: 'input_steer', properties: ['count'] },
  { name: 'cancel' },
] as const satisfies readonly TelemetryEventDefinition[];
