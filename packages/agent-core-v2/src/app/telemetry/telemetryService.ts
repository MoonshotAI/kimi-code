/**
 * `telemetry` domain (L1) — `ITelemetryService` implementation.
 *
 * Owns the appender set, enabled flag, and root context, and creates forwarding
 * context views that merge scoped properties at emission time. Views retain no
 * transport state, so appender and enablement changes remain controlled by the
 * App-scoped root. Has no cross-domain collaborators.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import type {
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventPayload,
} from './events';
import {
  ITelemetryService,
  type ITelemetryAppender,
  nullTelemetryAppender,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from './telemetry';

export class TelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;

  private appenders: ITelemetryAppender[] = [nullTelemetryAppender];
  private context: TelemetryProperties = {};
  private enabled = true;

  track(event: string, properties?: TelemetryProperties): void {
    if (!this.enabled) {
      return;
    }
    const merged = { ...this.context, ...properties };
    for (const appender of this.appenders) {
      try {
        appender.track(event, merged);
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.track(event, properties as TelemetryProperties);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetryContextView(this, patch);
  }

  setContext(patch: TelemetryContextPatch): void {
    this.context = { ...this.context, ...patch };
    for (const appender of this.appenders) {
      appender.setContext?.(patch);
    }
  }

  addAppender(appender: ITelemetryAppender): IDisposable {
    this.appenders.push(appender);
    return toDisposable(() => this.removeAppender(appender));
  }

  removeAppender(appender: ITelemetryAppender): void {
    this.appenders = this.appenders.filter((a) => a !== appender);
  }

  setAppender(appender: ITelemetryAppender): void {
    this.appenders = [appender];
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
}

class TelemetryContextView implements ITelemetryService {
  declare readonly _serviceBrand: undefined;
  private context: TelemetryProperties;

  constructor(
    private readonly root: ITelemetryService,
    context: TelemetryProperties,
  ) {
    this.context = context;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.root.track(event, { ...this.context, ...properties });
  }

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.track(event, properties as TelemetryProperties);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetryContextView(this.root, { ...this.context, ...patch });
  }

  setContext(patch: TelemetryContextPatch): void {
    this.context = { ...this.context, ...patch };
  }

  addAppender(appender: ITelemetryAppender): IDisposable {
    return this.root.addAppender(appender);
  }

  removeAppender(appender: ITelemetryAppender): void {
    this.root.removeAppender(appender);
  }

  setAppender(appender: ITelemetryAppender): void {
    this.root.setAppender(appender);
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
  InstantiationType.Eager,
  'telemetry',
);
