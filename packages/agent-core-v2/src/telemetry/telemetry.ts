/**
 * `telemetry` domain (L1) — `ITelemetryService` contract and appender types.
 *
 * Layer-1 root service: merges bound context into tracked events and fans
 * them out to one or more `ITelemetryAppender` destinations. App-scoped —
 * stateless beyond its appender set and bound context; enrichment, batching,
 * and transport are owned by the appenders, not by this layer. Defines the
 * `ITelemetryAppender` contract, the `ITelemetryService` facade, the service
 * options, and the null appender.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export type TelemetryPropertyValue = unknown;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export type TelemetryContextPatch = TelemetryProperties;

export interface ITelemetryAppender {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): ITelemetryAppender;
  setContext?(patch: TelemetryContextPatch): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface TelemetryServiceOptions {
  readonly appender?: ITelemetryAppender;
  readonly appenders?: readonly ITelemetryAppender[];
  readonly context?: TelemetryProperties;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface ITelemetryService {
  readonly _serviceBrand: undefined;
  track(event: string, properties?: TelemetryProperties): void;
  withContext(patch: TelemetryContextPatch): ITelemetryService;
  setContext(patch: TelemetryContextPatch): void;
  addAppender(appender: ITelemetryAppender): IDisposable;
  removeAppender(appender: ITelemetryAppender): void;
  setAppender(appender: ITelemetryAppender): void;
  setEnabled(enabled: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const nullTelemetryAppender: ITelemetryAppender = {
  track: () => {},
  withContext: () => nullTelemetryAppender,
  setContext: () => {},
  flush: () => {},
  shutdown: () => {},
};

/**
 * No-op `ITelemetryService` for callers that want to accept an optional
 * telemetry service (e.g. tools constructed outside DI in tests). Mirrors v1's
 * `noopTelemetryClient`.
 */
export const noopTelemetryService: ITelemetryService = {
  _serviceBrand: undefined,
  track: () => {},
  withContext: () => noopTelemetryService,
  setContext: () => {},
  addAppender: () => ({ dispose: () => {} }),
  removeAppender: () => {},
  setAppender: () => {},
  setEnabled: () => {},
  flush: async () => {},
  shutdown: async () => {},
};

export const ITelemetryService = createDecorator<ITelemetryService>(
  'agentTelemetryService',
);
