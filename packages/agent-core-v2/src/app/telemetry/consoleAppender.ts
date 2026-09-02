import type { ITelemetryAppender, TelemetryAppenderRecord } from './telemetry';
import type { TelemetryProperties } from './context';

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

  track(record: TelemetryAppenderRecord): void {
    const payload =
      Object.keys(record.properties).length === 0
        ? ''
        : ` ${stringifyProperties(record.properties, this.pretty)}`;
    this.log(`${this.prefix} ${record.event}${payload}`);
  }
}

function stringifyProperties(properties: TelemetryProperties, pretty: boolean): string {
  if (pretty) {
    return JSON.stringify(properties, null, 2);
  }
  return JSON.stringify(properties);
}

function defaultLog(message: string): void {
  console.log(message);
}
