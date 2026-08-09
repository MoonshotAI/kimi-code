/**
 * `telemetry` test stubs — shared `ITelemetryService` placeholder for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../telemetry/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import {
  ITelemetryService,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from '#/app/telemetry/telemetry';

export interface TelemetryRecord {
  readonly event: string;
  readonly properties?: TelemetryProperties;
}

export function recordingTelemetry(
  records: TelemetryRecord[],
  context: TelemetryProperties = {},
): ITelemetryService {
  let currentContext = context;
  let enabled = true;
  const service: ITelemetryService = {
    _serviceBrand: undefined,
    track(event, properties) {
      if (!enabled) return;
      records.push({
        event,
        properties:
          properties === undefined
            ? currentContext
            : { ...currentContext, ...properties },
      });
    },
    track2: (event, properties) => service.track(event, properties as TelemetryProperties),
    withContext(patch: TelemetryContextPatch) {
      return recordingTelemetry(records, { ...currentContext, ...patch });
    },
    setContext(patch: TelemetryContextPatch) {
      currentContext = { ...currentContext, ...patch };
    },
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setAppender: () => {},
    setEnabled(next) {
      enabled = next;
    },
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  return service;
}

export function registerTelemetryServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(ITelemetryService, {});
}
