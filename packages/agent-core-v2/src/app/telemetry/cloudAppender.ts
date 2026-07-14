/**
 * `telemetry` domain (L1) — `CloudAppender`, an `ITelemetryAppender` that
 * batches events, drops non-primitive properties, redacts PII from string
 * values, enriches events with common context, and posts them to the
 * telemetry endpoint through `CloudTransport`, which persists failed events
 * through the `storage` byte layer. Reads host facts (`clientVersion`, env,
 * platform/arch) from `IBootstrapService`; `createCloudAppender` assembles
 * one from a `ServicesAccessor` so hosts only supply identity facts.
 * App-scoped; independent of `@moonshot-ai/kimi-telemetry`.
 */

import { randomUUID } from 'node:crypto';
import { release } from 'node:os';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { ITelemetryAppender, TelemetryContextPatch, TelemetryProperties } from './telemetry';
import {
  type CloudContext,
  type CloudPrimitive,
  type CloudProperties,
  CloudTransport,
  type EnrichedCloudEvent,
  isCloudPrimitive,
} from './cloudTransport';
import { resolveCoreVersion } from './coreVersion';
import { cleanTelemetryProperties } from './privacy';

export interface CloudAppenderOptions {
  readonly storage: IFileSystemStorageService;
  readonly bootstrap: IBootstrapService;
  readonly deviceId: string;
  readonly sessionId?: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly endpoint?: string;
  readonly flushThreshold?: number;
  readonly flushIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export interface CloudAppenderHostOptions {
  readonly deviceId: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly sessionId?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
}

export function createCloudAppender(
  accessor: ServicesAccessor,
  host: CloudAppenderHostOptions,
): CloudAppender {
  return new CloudAppender({
    storage: accessor.get(IFileSystemStorageService),
    bootstrap: accessor.get(IBootstrapService),
    ...host,
  });
}

const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export class CloudAppender implements ITelemetryAppender {
  private readonly transport: CloudTransport;
  private readonly context: CloudContext;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private deviceId: string;
  private sessionId: string | null;
  private buffer: EnrichedCloudEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CloudAppenderOptions) {
    this.deviceId = options.deviceId;
    this.sessionId = options.sessionId ?? null;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.context = buildContext(options);
    this.transport = new CloudTransport({
      storage: options.storage,
      deviceId: options.deviceId,
      endpoint: options.endpoint,
      getAccessToken: options.getAccessToken,
      fetchImpl: options.fetchImpl,
      retryBackoffsMs: options.retryBackoffsMs,
      requestTimeoutMs: options.requestTimeoutMs,
      sleep: options.sleep,
      now: options.now,
    });
  }

  track(event: string, properties?: TelemetryProperties): void {
    const enriched: EnrichedCloudEvent = {
      event_id: randomUUID().replaceAll('-', ''),
      device_id: this.deviceId,
      session_id: this.sessionId,
      event,
      timestamp: Date.now() / 1000,
      properties: cleanTelemetryProperties(sanitizeProperties(properties)),
      context: { ...this.context },
    };
    this.buffer.push(enriched);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush().catch(() => {});
    }
  }

  setContext(patch: TelemetryContextPatch): void {
    const deviceId = patch['deviceId'];
    if (typeof deviceId === 'string') {
      this.deviceId = deviceId;
    }
    const sessionId = patch['sessionId'];
    if (typeof sessionId === 'string') {
      this.sessionId = sessionId;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    await this.transport.send(events);
  }

  async shutdown(): Promise<void> {
    this.stopPeriodicFlush();
    await this.flush();
  }

  startPeriodicFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  async retryDiskEvents(): Promise<void> {
    await this.transport.retryDiskEvents();
  }
}

function sanitizeProperties(input?: TelemetryProperties): CloudProperties {
  const out: CloudProperties = {};
  if (input === undefined) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isCloudPrimitive(value)) {
      out[key] = value;
    } else {
      onUnexpectedError(
        new Error(`telemetry property "${key}" is not a primitive and was dropped`),
      );
    }
  }
  return out;
}

function buildContext(options: CloudAppenderOptions): CloudContext {
  const { bootstrap } = options;
  const context: CloudContext = {
    app_name: options.appName,
    client_version: bootstrap.clientVersion,
    version: bootstrap.clientVersion,
    core_version: resolveCoreVersion(),
    runtime: 'node',
    platform: bootstrap.platform,
    arch: bootstrap.arch,
    node_version: process.versions.node,
    os_version: release(),
    ci: bootstrap.getEnv('CI') !== undefined,
    locale: options.locale ?? bootstrap.getEnv('LANG') ?? '',
    terminal: options.terminal ?? bootstrap.getEnv('TERM_PROGRAM') ?? '',
    ui_mode: options.uiMode ?? 'shell',
  };
  setPrimitive(context, 'model', options.model);
  setPrimitive(context, 'build_sha', options.buildSha);
  return context;
}

function setPrimitive(target: CloudContext, key: string, value: CloudPrimitive): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.length === 0) return;
  target[key] = value;
}
