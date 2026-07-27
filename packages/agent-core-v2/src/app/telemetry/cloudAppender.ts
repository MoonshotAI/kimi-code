/**
 * `telemetry` domain (L1) — `CloudAppender`, an `ITelemetryAppender` that
 * batches events, drops non-primitive properties, redacts PII from string
 * values, enriches events with common context, and posts them to the
 * telemetry endpoint through `CloudTransport`, which persists failed events
 * through the `storage` byte layer (`IFileSystemStorageService`). Reads host
 * facts (`clientVersion`, env, platform/arch) from `IBootstrapService`;
 * `createCloudAppender` assembles one from a `ServicesAccessor` so hosts only
 * supply identity facts.
 *
 * Shutdown lifecycle:
 * - `flush()` is guarded by a serial lock so concurrent periodic / threshold /
 *   manual triggers cannot race and lose ownership of a batch.
 * - `shutdown(deadlineMs?)` provides a deadline-bounded, idempotent close:
 *   cancels in-flight sends, hands unsent buffer to durable storage, replays
 *   recoverable v2 spool data before completing.
 * - Delivery is at-least-once across ambiguous cancellation boundaries; stable
 *   event IDs preserve the server's deduplication key.
 *
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
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export class CloudAppender implements ITelemetryAppender {
  private readonly transport: CloudTransport;
  private readonly context: CloudContext;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private deviceId: string;
  private sessionId: string | null;
  private buffer: EnrichedCloudEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Serial flush lock: prevents concurrent flush from racing on the buffer. */
  private flushInFlight: Promise<void> | null = null;
  /** Shutdown abort controller: cancels in-flight sends at the deadline. */
  private shutdownController: AbortController | null = null;
  /** Whether shutdown has completed (idempotent guard). */
  private shutDown = false;

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
    if (this.shutDown) return;
    const eventSessionId = properties?.['sessionId'];
    const enriched: EnrichedCloudEvent = {
      event_id: randomUUID().replaceAll('-', ''),
      device_id: this.deviceId,
      session_id: typeof eventSessionId === 'string' ? eventSessionId : this.sessionId,
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
    const model = patch['model'];
    if (typeof model === 'string') {
      setPrimitive(this.context, 'model', model);
    }
  }

  /**
   * Flush the current buffer to the cloud endpoint.
   *
   * Serialized through a single in-flight promise so concurrent callers
   * (periodic timer, threshold trigger, manual flush, shutdown) never race on
   * the buffer. If a flush is already running, the caller waits for it to
   * finish and then starts a new one for any events accumulated in the
   * meantime.
   */
  async flush(): Promise<void> {
    // Wait for any existing in-flight flush to complete before starting a new
    // one. This serializes access to `this.buffer` and prevents two callers
    // from both swapping the buffer and then one's send overwriting the other.
    if (this.flushInFlight !== null) {
      await this.flushInFlight.catch(() => {});
    }
    const flushPromise = this.doFlush();
    this.flushInFlight = flushPromise;
    try {
      await flushPromise;
    } finally {
      if (this.flushInFlight === flushPromise) {
        this.flushInFlight = null;
      }
    }
  }

  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    // Atomically swap the buffer so new track() calls go into a fresh array
    // while we send the captured batch.
    const events = this.buffer;
    this.buffer = [];
    const signal = this.shutdownController?.signal;
    await this.transport.send(events, signal);
  }

  /**
   * Durable, deadline-bounded, idempotent shutdown.
   *
   * 1. Stops the periodic flush timer.
   * 2. Sets an AbortController deadline; in-flight sends observe it.
   * 3. Flushes the remaining buffer (respects the deadline).
   * 4. Hands unsent buffered events to durable storage.
   * 5. Replays recoverable v2 spool data before completing.
   * 6. Marks the appender as shut down (idempotent).
   *
   * Hosts may retain an outer hard cap around non-cancellable local storage
   * I/O if desired.
   */
  async shutdown(deadlineMs?: number): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;

    // 1. Stop periodic flush — no new automatic triggers.
    this.stopPeriodicFlush();

    // 2. Create an abort controller with the deadline.
    const deadline = deadlineMs ?? Date.now() + DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.shutdownController = new AbortController();
    const remainingMs = Math.max(0, deadline - Date.now());

    // Schedule deadline abort for in-flight remote work.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (remainingMs > 0) {
      deadlineTimer = setTimeout(() => {
        this.shutdownController?.abort(new Error('shutdown deadline expired'));
      }, remainingMs);
      deadlineTimer.unref?.();
    } else {
      this.shutdownController.abort(new Error('shutdown deadline already expired'));
    }

    try {
      // 3. Flush remaining buffer (respects deadline via the abort signal).
      await this.flush().catch(() => {});

      // 4. If buffer still has items (e.g. send failed at deadline), hand to
      //    durable storage so they survive a restart.
      if (this.buffer.length > 0) {
        await this.transport.saveToDisk(this.buffer).catch(() => {});
        this.buffer = [];
      }

      // 5. Replay recoverable v2 spool data. Legacy spool files (owned by the
      //    legacy telemetry pipeline) are left untouched — retryDiskEvents
      //    only touches the v2 `failed_*.jsonl` namespace.
      await this.transport.retryDiskEvents().catch(() => {});
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
    }
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
