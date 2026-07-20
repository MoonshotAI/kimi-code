/**
 * `telemetry` domain (L1) — `ConsoleAppender`, an `ITelemetryAppender` that
 * echoes events to a log function for development and debugging. App-scoped;
 * has no cross-domain collaborators.
 */

import type { ITelemetryAppender, TelemetryProperties } from './telemetry';

export interface ConsoleAppenderOptions {
  readonly prefix?: string;
  readonly pretty?: boolean;
  readonly log?: (message: string) => void;
}

const DEFAULT_PREFIX = '[telemetry]';

export class ConsoleAppender implements ITelemetryAppender {
  private readonly prefix: string;
  private readonly pretty: boolean;
  private readonly log: (message: string) => void;

  constructor(options: ConsoleAppenderOptions = {}) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.pretty = options.pretty ?? false;
    this.log = options.log ?? defaultLog;
  }

  track(event: string, properties?: TelemetryProperties): void {
    const payload =
      properties === undefined ? '' : ` ${stringifyProperties(properties, this.pretty)}`;
    this.log(`${this.prefix} ${event}${payload}`);
  }
}

function stringifyProperties(properties: TelemetryProperties, pretty: boolean): string {
  if (pretty) {
    return JSON.stringify(properties, null, 2);
  }
  return JSON.stringify(properties);
}

function defaultLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}
