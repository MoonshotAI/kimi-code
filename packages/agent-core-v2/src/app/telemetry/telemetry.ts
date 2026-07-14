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

import type {
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventProperties,
} from './events';

export type TelemetryPrimitive = string | number | boolean | null | undefined;

export type TelemetryProperties = Readonly<Record<string, TelemetryPrimitive>>;

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
  track2<K extends TelemetryEventName, E extends TelemetryEventProperties<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventProperties<K>, E>,
  ): void;
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

export const noopTelemetryService: ITelemetryService = {
  _serviceBrand: undefined,
  track: () => {},
  track2: () => {},
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
