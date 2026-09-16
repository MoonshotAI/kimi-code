import { arch, platform, release } from 'node:os';

import type {
  EnrichedTelemetryEvent,
  TelemetryContext,
  TelemetryEvent,
  TelemetryPrimitive,
  TelemetryTransport,
} from './types';

export interface EventSinkContextOptions {
  readonly appName: string;
  readonly version: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EventSinkOptions {
  readonly transport: TelemetryTransport;
  readonly context: EventSinkContextOptions;
  readonly flushIntervalMs?: number;
  readonly flushThreshold?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_FLUSH_THRESHOLD = 50;

export class EventSink {
  private readonly transport: TelemetryTransport;
  private readonly context: TelemetryContext;
  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;
  private buffer: EnrichedTelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private activeBatch: readonly EnrichedTelemetryEvent[] | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: EventSinkOptions) {
    this.transport = options.transport;
    this.context = buildContext(options.context);
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  }

  accept(event: TelemetryEvent): void {
    // The per-event model rides in the envelope context: a string wins over
    // the sink's reconciled model, an explicit null clears it (forwarded
    // app-scoped events must not inherit it), and undefined keeps it.
    const { model, ...rest } = event;
    const enriched: EnrichedTelemetryEvent = {
      ...rest,
      context: { ...this.context },
    };
    if (model === null) {
      delete enriched.context['model'];
    } else {
      setPrimitive(enriched.context, 'model', model);
    }
    this.buffer.push(enriched);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush().catch(() => {});
    }
  }

  setModel(model: string): void {
    setPrimitive(this.context, 'model', model);
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

  clearBuffer(): void {
    this.buffer = [];
  }

  async flush(signal?: AbortSignal): Promise<void> {
    // The chain advances by operation, not by caller: this flush's link
    // settles only after the previous send settles and this flush's own send
    // (if any) completes — a caller whose join aborts never releases its
    // successors early.
    const previous = this.tail;
    let settleSelf!: () => void;
    const self = new Promise<void>((resolve) => {
      settleSelf = resolve;
    });
    this.tail = previous.then(
      () => self,
      () => self,
    );

    // The caller's join of the previous operation, bounded by its signal.
    let joinAborted = false;
    try {
      await raceWithSignal(previous, signal);
    } catch (error) {
      joinAborted = true;
      // The timeout gave up on a send that still owns its batch: spool that
      // batch to disk so host unload cannot lose it. The send may still
      // succeed afterwards — a rare duplicate beats a lost batch.
      if (this.activeBatch !== null) {
        try {
          this.transport.saveToDisk(this.activeBatch);
        } catch {
          // Telemetry must never make shutdown fail.
        }
      }
      settleSelf();
      throw error;
    }
    if (this.buffer.length === 0) {
      settleSelf();
      return;
    }
    const events = this.buffer;
    this.buffer = [];
    this.activeBatch = events;
    try {
      await this.transport.send(events, signal);
    } finally {
      this.activeBatch = null;
      settleSelf();
    }
  }

  flushSync(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    try {
      this.transport.saveToDisk(events);
    } catch {
      // Telemetry must never make shutdown fail.
    }
  }
}

function buildContext(options: EventSinkContextOptions): TelemetryContext {
  const env = options.env ?? process.env;
  const context: TelemetryContext = {
    app_name: options.appName,
    version: options.version,
    runtime: 'node',
    platform: platform(),
    arch: arch(),
    node_version: process.versions.node,
    os_version: release(),
    ci: env['CI'] !== undefined,
    locale: options.locale ?? env['LANG'] ?? '',
    terminal: options.terminal ?? env['TERM_PROGRAM'] ?? '',
    ui_mode: options.uiMode ?? 'shell',
  };
  setPrimitive(context, 'model', options.model);
  setPrimitive(context, 'build_sha', options.buildSha);
  return context;
}

function setPrimitive(
  target: TelemetryContext,
  key: string,
  value: TelemetryPrimitive | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.length === 0) return;
  target[key] = value;
}

/** Await a send already in flight, but reject as soon as the signal aborts. */
function raceWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  const settled = promise.catch(() => {
    // The original owner surfaces the failure; joining is about ordering.
  });
  if (signal === undefined) return settled;
  return Promise.race([
    settled,
    new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => {
        const error = new Error('flush join aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
}
