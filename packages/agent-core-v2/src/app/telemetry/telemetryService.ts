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

const ROOT_CHAIN: readonly string[] = [];

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

export interface ITelemetryScopeBindingHost {
  createScopeBinding(segment: string, seed: TelemetryContextPatch): TelemetryScopeBinding;
}

export function bindTelemetryScope(
  parent: ITelemetryService,
  segment: string,
  seed: TelemetryContextPatch,
): TelemetryScopeBinding {
  const host = parent as ITelemetryService & Partial<ITelemetryScopeBindingHost>;
  if (host.createScopeBinding !== undefined) {
    return host.createScopeBinding(segment, seed);
  }
  return { telemetry: parent.withContext(seed), dispose: () => {} };
}

export class TelemetryService implements ITelemetryService, ITelemetryScopeBindingHost {
  declare readonly _serviceBrand: undefined;

  private appenders: ITelemetryAppender[] = [nullTelemetryAppender];
  private readonly fragments = new Map<string, MutableContext>();
  private context: MutableContext = {};
  private enabled = true;

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.dispatch(event, this.ambientFor(ROOT_CHAIN), properties as TelemetryProperties | undefined);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetrySnapshotView(this, applyPatch(this.ambientFor(ROOT_CHAIN), patch));
  }

  setContext(patch: TelemetryContextPatch): void {
    applyPatch(this.context, patch);
  }

  getContext(): Readonly<TelemetryContextPatch> {
    return this.ambientFor(ROOT_CHAIN);
  }

  createScopeBinding(segment: string, seed: TelemetryContextPatch): TelemetryScopeBinding {
    const { fragment, release } = this.registerFragment(segment, seed);
    const bound = new BoundTelemetryService(this, segment, fragment, [segment], release);
    return { telemetry: bound, dispose: () => bound.dispose() };
  }

  registerFragment(
    key: string,
    seed: TelemetryContextPatch,
  ): { readonly fragment: MutableContext; readonly release: () => void } {
    const fragment: MutableContext = {};
    applyPatch(fragment, seed);
    this.fragments.set(key, fragment);
    return {
      fragment,
      release: () => {
        if (this.fragments.get(key) === fragment) {
          this.fragments.delete(key);
        }
      },
    };
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

  ambientFor(chain: readonly string[]): TelemetryProperties {
    let merged: MutableContext = { ...this.context };
    for (const key of chain) {
      const fragment = this.fragments.get(key);
      if (fragment !== undefined) {
        merged = { ...merged, ...fragment };
      }
    }
    return merged;
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

class BoundTelemetryService implements ITelemetryService, ITelemetryScopeBindingHost {
  declare readonly _serviceBrand: undefined;

  private disposed = false;

  constructor(
    private readonly root: TelemetryService,
    private readonly key: string,
    private readonly fragment: MutableContext,
    private readonly chain: readonly string[],
    private readonly release: () => void,
  ) {}

  private ambient(): TelemetryProperties {
    const inherited = this.root.ambientFor(this.chain.slice(0, -1));
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

  createScopeBinding(segment: string, seed: TelemetryContextPatch): TelemetryScopeBinding {
    const key = `${this.key}/${segment}`;
    const { fragment, release } = this.root.registerFragment(key, seed);
    const bound = new BoundTelemetryService(
      this.root,
      key,
      fragment,
      [...this.chain, key],
      release,
    );
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
    if (!this.disposed) {
      this.disposed = true;
      this.release();
    }
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
