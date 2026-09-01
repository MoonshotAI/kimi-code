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
  telemetryEventDefinitions,
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

const FILTERED_CONTEXT_KEYS = [
  'turn_id',
  'trace_id',
  'thinking_effort',
  'mode',
  'provider_type',
  'protocol',
] as const;

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

function declaredKeysFor(event: string): readonly string[] | undefined {
  const definition = (
    telemetryEventDefinitions as Record<
      string,
      | { readonly context: string; readonly meta: { readonly properties: Readonly<Record<string, string>> } }
      | undefined
    >
  )[event];
  if (definition === undefined) {
    return undefined;
  }
  const keys = Object.keys(definition.meta.properties);
  return definition.context === 'agent' && !keys.includes('agent_id')
    ? [...keys, 'agent_id']
    : keys;
}

export function composeTelemetryProperties(
  event: string,
  ambient: TelemetryProperties,
  explicit: TelemetryProperties | undefined,
): TelemetryProperties {
  const properties: MutableContext = {};
  if (ambient['session_id'] !== undefined) {
    properties['sessionId'] = ambient['session_id'];
  }
  if (ambient['agent_id'] !== undefined) {
    properties['agent_id'] = ambient['agent_id'];
  }
  if (ambient['model'] !== undefined) {
    properties['model'] = ambient['model'];
  }
  const declared = declaredKeysFor(event);
  if (declared !== undefined) {
    for (const key of declared) {
      if (key === 'agent_id') continue;
      const value = ambient[key];
      if (value !== undefined) {
        properties[key] = value;
      }
    }
  }
  if (explicit !== undefined) {
    Object.assign(properties, explicit);
  }
  if (declared !== undefined) {
    for (const key of FILTERED_CONTEXT_KEYS) {
      if (!declared.includes(key)) {
        delete properties[key];
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
      properties: composeTelemetryProperties(event, ambient, properties),
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

  constructor(
    private readonly root: TelemetryService,
    private readonly key: string,
    private readonly fragment: MutableContext,
    private readonly chain: readonly string[],
    private readonly release: () => void,
  ) {}

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.root.dispatch(event, this.root.ambientFor(this.chain), properties as TelemetryProperties | undefined);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetrySnapshotView(
      this.root,
      applyPatch({ ...this.root.ambientFor(this.chain) }, patch),
    );
  }

  setContext(patch: TelemetryContextPatch): void {
    applyPatch(this.fragment, patch);
  }

  getContext(): Readonly<TelemetryContextPatch> {
    return this.root.ambientFor(this.chain);
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
    this.release();
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
