import { randomUUID } from 'node:crypto';

import type { EventSink } from './sink';
import type { TelemetryEvent, TelemetryProperties } from './types';
import { isTelemetryPrimitive } from './types';

export interface TelemetryContextIds {
  readonly deviceId?: string | null;
  readonly sessionId?: string | null;
}

export interface TelemetryShutdownOptions {
  readonly timeoutMs?: number;
}

export interface SystemMetricsCollectorHandle {
  stop(): void;
}

const MAX_QUEUE_SIZE = 1000;

interface PendingTelemetryEvent extends TelemetryEvent {
  readonly contextOverrides?: {
    readonly deviceId?: boolean;
    readonly sessionId?: boolean;
  };
}

export class TelemetryClient {
  private queue: PendingTelemetryEvent[] = [];
  private sink: EventSink | null = null;
  private systemMetricsCollector: SystemMetricsCollectorHandle | null = null;
  private deviceId: string | null = null;
  private sessionId: string | null = null;
  private disabled = false;

  setContext(input: TelemetryContextIds): void {
    if (input.deviceId !== undefined) this.deviceId = input.deviceId;
    if (input.sessionId !== undefined) this.sessionId = input.sessionId;
  }

  withContext(input: TelemetryContextIds): TelemetryClient {
    return new ScopedTelemetryClient(this, input);
  }

  setSystemMetricsCollector(collector: SystemMetricsCollectorHandle): void {
    if (this.systemMetricsCollector !== null && this.systemMetricsCollector !== collector) {
      this.systemMetricsCollector.stop();
    }
    this.systemMetricsCollector = collector;
  }

  attachSink(sink: EventSink): void {
    if (this.sink !== null && this.sink !== sink) {
      this.sink.stopPeriodicFlush();
      this.sink.flushSync();
    }
    this.sink = sink;
    for (const event of this.queue) {
      const record = toTelemetryEvent(event);
      if (record.device_id === null && event.contextOverrides?.deviceId !== true) {
        record.device_id = this.deviceId;
      }
      if (record.session_id === null && event.contextOverrides?.sessionId !== true) {
        record.session_id = this.sessionId;
      }
      sink.accept(record);
    }
    this.queue = [];
  }

  disable(): void {
    this.disabled = true;
    this.queue = [];
    this.systemMetricsCollector?.stop();
    this.systemMetricsCollector = null;
    if (this.sink !== null) {
      this.sink.stopPeriodicFlush();
      this.sink.clearBuffer();
      this.sink = null;
    }
  }

  enable(): void {
    this.disabled = false;
  }

  track(event: string, properties: TelemetryProperties = {}): void {
    this.trackWithContext(event, properties, {});
  }

  trackWithContext(
    event: string,
    properties: TelemetryProperties = {},
    context: TelemetryContextIds,
  ): void {
    if (this.disabled) return;
    const record: PendingTelemetryEvent = {
      event_id: randomUUID().replaceAll('-', ''),
      device_id: context.deviceId === undefined ? this.deviceId : context.deviceId,
      session_id: context.sessionId === undefined ? this.sessionId : context.sessionId,
      event,
      timestamp: Date.now() / 1000,
      properties: sanitizeProperties(properties),
      contextOverrides: {
        deviceId: context.deviceId !== undefined,
        sessionId: context.sessionId !== undefined,
      },
    };
    if (this.sink !== null) {
      this.sink.accept(toTelemetryEvent(record));
      return;
    }
    this.queue.push(record);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(this.queue.length - MAX_QUEUE_SIZE);
    }
  }

  getSink(): EventSink | null {
    return this.sink;
  }

  async flush(signal?: AbortSignal): Promise<void> {
    await this.sink?.flush(signal);
  }

  flushSync(): void {
    this.sink?.flushSync();
  }

  async shutdown(options: TelemetryShutdownOptions = {}): Promise<void> {
    this.systemMetricsCollector?.stop();
    this.systemMetricsCollector = null;
    const sink = this.sink;
    if (sink === null) return;
    sink.stopPeriodicFlush();
    if (options.timeoutMs === undefined) {
      await sink.flush();
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);
    timer.unref?.();
    try {
      await sink.flush(controller.signal);
    } catch {
      sink.flushSync();
    } finally {
      clearTimeout(timer);
    }
  }

  resetForTests(): void {
    this.sink?.stopPeriodicFlush();
    this.systemMetricsCollector?.stop();
    this.systemMetricsCollector = null;
    this.queue = [];
    this.sink = null;
    this.deviceId = null;
    this.sessionId = null;
    this.disabled = false;
  }
}

class ScopedTelemetryClient extends TelemetryClient {
  constructor(
    private readonly parent: TelemetryClient,
    private readonly context: TelemetryContextIds,
  ) {
    super();
  }

  override setContext(input: TelemetryContextIds): void {
    this.parent.setContext(input);
  }

  override withContext(input: TelemetryContextIds): TelemetryClient {
    return new ScopedTelemetryClient(this.parent, mergeContext(this.context, input));
  }

  override setSystemMetricsCollector(collector: SystemMetricsCollectorHandle): void {
    this.parent.setSystemMetricsCollector(collector);
  }

  override attachSink(sink: EventSink): void {
    this.parent.attachSink(sink);
  }

  override disable(): void {
    this.parent.disable();
  }

  override enable(): void {
    this.parent.enable();
  }

  override track(event: string, properties: TelemetryProperties = {}): void {
    this.parent.trackWithContext(event, properties, this.context);
  }

  override getSink(): EventSink | null {
    return this.parent.getSink();
  }

  override async flush(signal?: AbortSignal): Promise<void> {
    await this.parent.flush(signal);
  }

  override flushSync(): void {
    this.parent.flushSync();
  }

  override async shutdown(options: TelemetryShutdownOptions = {}): Promise<void> {
    await this.parent.shutdown(options);
  }

  override resetForTests(): void {
    this.parent.resetForTests();
  }
}

const defaultClient = new TelemetryClient();

export function setContext(input: TelemetryContextIds): void {
  defaultClient.setContext(input);
}

export function attachSink(sink: EventSink): void {
  defaultClient.attachSink(sink);
}

export function disable(): void {
  defaultClient.disable();
}

export function enable(): void {
  defaultClient.enable();
}

export function track(event: string, properties: TelemetryProperties = {}): void {
  defaultClient.track(event, properties);
}

export function withContext(input: TelemetryContextIds): TelemetryClient {
  return defaultClient.withContext(input);
}

export function getSink(): EventSink | null {
  return defaultClient.getSink();
}

export function flushSync(): void {
  defaultClient.flushSync();
}

export async function shutdown(options: TelemetryShutdownOptions = {}): Promise<void> {
  await defaultClient.shutdown(options);
}

export function getDefaultTelemetryClient(): TelemetryClient {
  return defaultClient;
}

export function resetDefaultTelemetryClientForTests(): void {
  defaultClient.resetForTests();
}

function mergeContext(base: TelemetryContextIds, patch: TelemetryContextIds): TelemetryContextIds {
  return {
    deviceId: patch.deviceId === undefined ? base.deviceId : patch.deviceId,
    sessionId: patch.sessionId === undefined ? base.sessionId : patch.sessionId,
  };
}

function toTelemetryEvent(event: PendingTelemetryEvent): TelemetryEvent {
  return {
    event_id: event.event_id,
    device_id: event.device_id,
    session_id: event.session_id,
    event: event.event,
    timestamp: event.timestamp,
    properties: event.properties,
  };
}

function sanitizeProperties(input: TelemetryProperties): TelemetryProperties {
  const out: TelemetryProperties = {};
  for (const [key, value] of Object.entries(input)) {
    if (isTelemetryPrimitive(value)) {
      out[key] = value;
    }
  }
  return out;
}
