/**
 * `telemetry` domain barrel — re-exports the `telemetry` contract and its
 * scoped service (`telemetryService`). Importing this barrel registers the
 * `ITelemetryService` binding into the scope registry.
 */

export * from './telemetry';
export * from './telemetryService';
