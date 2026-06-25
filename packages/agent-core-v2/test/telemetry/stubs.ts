/**
 * `telemetry` test stubs — shared `ITelemetryService` placeholder for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../telemetry/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { ITelemetryService } from '#/telemetry/telemetry';

/**
 * Register an empty `ITelemetryService` placeholder. Tests that assert on
 * telemetry should register a spy via `additionalServices` instead.
 */
export function registerTelemetryServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(ITelemetryService, {});
}
