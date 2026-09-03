import {
  flushSync,
  setContext,
  shutdown,
  track as trackEvent,
  withContext,
} from './client';
import type { TelemetryProperties as TelemetryPropertiesType } from './types';
import type { TelemetryContextIds, TelemetryClient } from './client';

export function track(event: string, properties: TelemetryPropertiesType = {}): void {
  trackEvent(event, properties);
}

export function setTelemetryContext(patch: TelemetryContextIds): void {
  setContext(patch);
}

export function withTelemetryContext(patch: TelemetryContextIds): TelemetryClient {
  return withContext(patch);
}

export function flushTelemetrySync(): void {
  flushSync();
}

export async function shutdownTelemetry(
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  await shutdown(options);
}

export { initializeTelemetry, shouldEnableTelemetry } from './bootstrap';
export type { TelemetryBootstrapOptions } from './bootstrap';

export { installCrashHandlers, setCrashPhase } from './crash';
export type { CrashPhase } from './crash';

export { normalizeRemote } from './remote';

export type { TelemetryPrimitive, TelemetryProperties } from './types';
export type { TelemetryClient, TelemetryContextIds } from './client';
