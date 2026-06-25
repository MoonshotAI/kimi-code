/**
 * `telemetry` domain (L1) — telemetry event tracking facade.
 *
 * Defines the public contract of telemetry: the `TelemetryContext` /
 * `TelemetryProperties` model and the `ITelemetryService` used by other
 * domains to record events, plus the `TelemetryClient` it delegates to.
 * Core-scoped — one shared instance for the process.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type TelemetryPropertyValue = boolean | number | string | undefined | null;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export interface TelemetryContext {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
};

export interface ITelemetryService {
  readonly _serviceBrand: undefined;
  track(event: string, properties?: TelemetryProperties): void;
  withContext(patch: TelemetryContext): ITelemetryService;
}

export const ITelemetryService: ServiceIdentifier<ITelemetryService> =
  createDecorator<ITelemetryService>('telemetryService');
