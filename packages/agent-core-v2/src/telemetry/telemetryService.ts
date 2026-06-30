/**
 * `telemetry` domain (L1) — `ITelemetryService` implementation.
 *
 * Merges bound context into each tracked event and fans it out to the
 * registered `ITelemetryAppender` destinations; owns the appender set, the
 * enabled flag, and the bound context, but no enrichment or transport of its
 * own. Bound at Core scope; has no cross-domain collaborators.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

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

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    const child = new TelemetryService();
    child.appenders = this.appenders.map((appender) => appender.withContext?.(patch) ?? appender);
    child.context = { ...this.context, ...patch };
    child.enabled = this.enabled;
    return child;
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

registerScopedService(
  LifecycleScope.Core,
  ITelemetryService,
  TelemetryService,
  InstantiationType.Delayed,
  'telemetry',
);
