import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import type {
  TelemetryContextPatch,
  TelemetryPrimitive,
  TelemetryProperties,
} from './context';
import {
  type StrictPropertyCheck,
  type TelemetryEventName,
  type TelemetryEventPayload,
} from './events';
import {
  type ITelemetryAppender,
  ITelemetryService,
  nullTelemetryAppender,
  type TelemetryAppenderRecord,
} from './telemetry';

type MutableContext = Record<string, TelemetryPrimitive>;

const WIRE_SESSION_ID_PROPERTY = 'sessionId';

function applyPatch(target: MutableContext, patch: TelemetryContextPatch): MutableContext {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function composeTelemetryProperties(
  ambient: TelemetryProperties,
  explicit: TelemetryProperties | undefined,
): TelemetryProperties {
  const properties: MutableContext = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (key === 'session_id' || value === undefined) {
      continue;
    }
    properties[key] = value;
  }
  if (ambient['session_id'] !== undefined) {
    properties[WIRE_SESSION_ID_PROPERTY] = ambient['session_id'];
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

export interface TelemetryScopeBinding extends IDisposable {
  readonly telemetry: ITelemetryService;
}

interface TelemetryAmbientSource {
  ambient(): TelemetryProperties;
}

export interface ITelemetryScopeBindingHost {
  createScopeBinding(seed: TelemetryContextPatch): TelemetryScopeBinding;
}

export function bindTelemetryScope(
  parent: ITelemetryService,
  seed: TelemetryContextPatch,
): TelemetryScopeBinding {
  const host = parent as ITelemetryService & Partial<ITelemetryScopeBindingHost>;
  if (host.createScopeBinding !== undefined) {
    return host.createScopeBinding(seed);
  }
  return { telemetry: parent.withContext(seed), dispose: () => {} };
}

export class TelemetryService
  implements ITelemetryService, ITelemetryScopeBindingHost, TelemetryAmbientSource
{
  declare readonly _serviceBrand: undefined;

  private appenders: ITelemetryAppender[] = [nullTelemetryAppender];
  private context: MutableContext = {};
  private enabled = true;

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.dispatch(event, this.ambient(), properties as TelemetryProperties | undefined);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetrySnapshotView(this, applyPatch(this.ambient(), patch));
  }

  setContext(patch: TelemetryContextPatch): void {
    applyPatch(this.context, patch);
  }

  getContext(): Readonly<TelemetryContextPatch> {
    return this.ambient();
  }

  createScopeBinding(seed: TelemetryContextPatch): TelemetryScopeBinding {
    const bound = new BoundTelemetryService(this, this, applyPatch({}, seed));
    return { telemetry: bound, dispose: () => bound.dispose() };
  }

  addAppender(appender: ITelemetryAppender): IDisposable {
    this.appenders.push(appender);
    return toDisposable(() => this.removeAppender(appender));
  }

  removeAppender(appender: ITelemetryAppender): void {
    this.appenders = this.appenders.filter((a) => a !== appender);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.appenders.map((appender) =>
        Promise.resolve(appender.flush?.()).catch(onUnexpectedError),
      ),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.appenders.map((appender) =>
        Promise.resolve(appender.shutdown?.()).catch(onUnexpectedError),
      ),
    );
  }

  ambient(): TelemetryProperties {
    return { ...this.context };
  }

  dispatch(
    event: string,
    ambient: TelemetryProperties,
    properties: TelemetryProperties | undefined,
  ): void {
    if (!this.enabled) {
      return;
    }
    const record: TelemetryAppenderRecord = {
      event,
      context: { ...ambient },
      properties: composeTelemetryProperties(ambient, properties),
    };
    for (const appender of this.appenders) {
      try {
        appender.track(record);
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }
}

class BoundTelemetryService
  implements ITelemetryService, ITelemetryScopeBindingHost, TelemetryAmbientSource
{
  declare readonly _serviceBrand: undefined;

  private disposed = false;

  constructor(
    private readonly root: TelemetryService,
    private readonly parent: TelemetryAmbientSource,
    private readonly fragment: MutableContext,
  ) {}

  ambient(): TelemetryProperties {
    const inherited = this.parent.ambient();
    if (this.disposed) {
      return inherited;
    }
    return { ...inherited, ...this.fragment };
  }

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.root.dispatch(event, this.ambient(), properties as TelemetryProperties | undefined);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetrySnapshotView(
      this.root,
      applyPatch(this.ambient(), patch),
    );
  }

  setContext(patch: TelemetryContextPatch): void {
    if (!this.disposed) {
      applyPatch(this.fragment, patch);
    }
  }

  getContext(): Readonly<TelemetryContextPatch> {
    return this.ambient();
  }

  createScopeBinding(seed: TelemetryContextPatch): TelemetryScopeBinding {
    const bound = new BoundTelemetryService(this.root, this, applyPatch({}, seed));
    return { telemetry: bound, dispose: () => bound.dispose() };
  }

  addAppender(appender: ITelemetryAppender): IDisposable {
    return this.root.addAppender(appender);
  }

  removeAppender(appender: ITelemetryAppender): void {
    this.root.removeAppender(appender);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  flush(): Promise<void> {
    return this.root.flush();
  }

  shutdown(): Promise<void> {
    return this.root.shutdown();
  }

  dispose(): void {
    this.disposed = true;
  }
}

class TelemetrySnapshotView implements ITelemetryService {
  declare readonly _serviceBrand: undefined;
  private context: MutableContext;

  constructor(
    private readonly root: TelemetryService,
    context: TelemetryProperties,
  ) {
    this.context = { ...context };
  }

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.root.dispatch(event, this.context, properties as TelemetryProperties | undefined);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetrySnapshotView(this.root, applyPatch({ ...this.context }, patch));
  }

  setContext(patch: TelemetryContextPatch): void {
    applyPatch(this.context, patch);
  }

  getContext(): Readonly<TelemetryContextPatch> {
    return { ...this.context };
  }

  addAppender(appender: ITelemetryAppender): IDisposable {
    return this.root.addAppender(appender);
  }

  removeAppender(appender: ITelemetryAppender): void {
    this.root.removeAppender(appender);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  flush(): Promise<void> {
    return this.root.flush();
  }

  shutdown(): Promise<void> {
    return this.root.shutdown();
  }
}

registerScopedService(
  LifecycleScope.App,
  ITelemetryService,
  TelemetryService,
  ScopeActivation.OnScopeCreated,
  'telemetry',
);
