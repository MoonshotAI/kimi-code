/**
 * `telemetry` domain (L1) — `ITelemetryService` implementation.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type TelemetryClient,
  type TelemetryContext,
  type TelemetryProperties,
  ITelemetryService,
  noopTelemetryClient,
} from './telemetry';

export class TelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;
  private delegate: TelemetryClient;

  constructor(private readonly context: TelemetryContext = {}) {
    this.delegate = noopTelemetryClient;
  }

  /** Wire the real emission sink. Called by the host after bootstrap. */
  setDelegate(client: TelemetryClient): void {
    this.delegate = client;
  }

  track(event: string, properties?: TelemetryProperties): void {
    const merged: TelemetryProperties = { ...this.context, ...properties };
    this.delegate.track(event, merged);
  }

  withContext(patch: TelemetryContext): ITelemetryService {
    const child = new TelemetryService({ ...this.context, ...patch });
    child.delegate = this.delegate;
    return child;
  }
}

registerScopedService(
  LifecycleScope.Core,
  ITelemetryService,
  TelemetryService,
  InstantiationType.Eager,
  'telemetry',
);
