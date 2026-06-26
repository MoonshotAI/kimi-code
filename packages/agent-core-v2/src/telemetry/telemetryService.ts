/**
 * `telemetry` domain (L1) — `ITelemetryService` implementation.
 *
 * Merges the bound `TelemetryContext` into each event and forwards it to the
 * configured `TelemetryClient`; supports child contexts via `withContext`.
 * Bound at Core scope.
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
