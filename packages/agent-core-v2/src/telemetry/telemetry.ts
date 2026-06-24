/**
 * `telemetry` domain (L1) — Core-scope telemetry contract.
 *
 * v2 exposes `ITelemetryService` as a Core-scope DI service. Scoped services
 * call `withContext({ sessionId, agentId, turnId })` to bind identity fields
 * before tracking, replacing v1's "telemetry threaded through every
 * constructor" pattern. The real emission sink (the
 * `@moonshot-ai/kimi-telemetry` client) is wired by the host via
 * `setDelegate`; the engine defaults to a noop sink so it is safe to use
 * before the host bootstraps telemetry.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type TelemetryPropertyValue = boolean | number | string | undefined | null;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export interface TelemetryContext {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

/**
 * Low-level emission sink. The host (server/SDK) provides an implementation
 * backed by `@moonshot-ai/kimi-telemetry`; tests provide a capturing one.
 */
export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
};

export interface ITelemetryService {
  readonly _serviceBrand: undefined;
  track(event: string, properties?: TelemetryProperties): void;
  /** Returns a child service that merges `patch` into the bound context. */
  withContext(patch: TelemetryContext): ITelemetryService;
}

export const ITelemetryService: ServiceIdentifier<ITelemetryService> =
  createDecorator<ITelemetryService>('telemetryService');
