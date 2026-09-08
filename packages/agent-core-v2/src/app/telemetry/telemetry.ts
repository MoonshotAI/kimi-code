import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type {
  TelemetryContextPatch,
  TelemetryPrimitive,
  TelemetryProperties,
} from './context';
import type {
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventPayload,
} from './events';

export type { TelemetryContextPatch, TelemetryPrimitive, TelemetryProperties } from './context';

export interface TelemetryAppenderRecord {
  readonly event: string;
  readonly context: TelemetryProperties;
  readonly properties: TelemetryProperties;
}

export interface ITelemetryAppender {
  track(record: TelemetryAppenderRecord): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface TelemetryScopeBinding extends IDisposable {
  readonly telemetry: ITelemetryService;
}

export interface ITelemetryService {
  readonly _serviceBrand: undefined;

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void;
  withContext(patch: TelemetryContextPatch): ITelemetryService;
  setContext(patch: TelemetryContextPatch): void;
  getContext(): Readonly<TelemetryContextPatch>;
  createScopeBinding(seed: TelemetryContextPatch): TelemetryScopeBinding;
}

export interface ITelemetryAdminService {
  addAppender(appender: ITelemetryAppender): IDisposable;
  removeAppender(appender: ITelemetryAppender): void;
  setEnabled(enabled: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function asTelemetryAdmin(service: ITelemetryService): ITelemetryAdminService | undefined {
  const candidate = service as ITelemetryService & Partial<ITelemetryAdminService>;
  if (typeof candidate.addAppender !== 'function') {
    return undefined;
  }
  return candidate as ITelemetryAdminService;
}

export const nullTelemetryAppender: ITelemetryAppender = {
  track: () => {},
  flush: () => {},
  shutdown: () => {},
};

const EMPTY_CONTEXT: Readonly<TelemetryContextPatch> = Object.freeze({});

export const noopTelemetryService: ITelemetryService = {
  _serviceBrand: undefined,
  track2: () => {},
  withContext: () => noopTelemetryService,
  setContext: () => {},
  getContext: () => EMPTY_CONTEXT,
  createScopeBinding: () => noopTelemetryScopeBinding,
};

const noopTelemetryScopeBinding: TelemetryScopeBinding = {
  telemetry: noopTelemetryService,
  dispose: () => {},
};

export const ITelemetryService = createDecorator<ITelemetryService>(
  'agentTelemetryService',
);
