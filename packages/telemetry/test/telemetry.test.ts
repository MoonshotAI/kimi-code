import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushTelemetrySync, initializeTelemetry, shutdownTelemetry, track } from '../src';
import { isTelemetryDisabledByEnv } from '../src/bootstrap';
import { TelemetryClient, resetDefaultTelemetryClientForTests } from '../src/client';
import { installCrashHandlersForClient, setCrashPhase, uninstallCrashHandlers } from '../src/crash';
import { EventSink } from '../src/sink';
import { SystemMetricsCollector } from '../src/systemMetrics';
import {
  AsyncTransport,
  DISK_EVENT_MAX_AGE_MS,
  RETRY_BACKOFFS_MS,
  SERVER_EVENT_PREFIX,
  TransientTelemetryError,
  USER_ID_PREFIX,
  applyServerPrefix,
  buildPayload,
} from '../src/transport';
import type { EnrichedTelemetryEvent, TelemetryEvent, TelemetryTransport } from '../src/types';

const tempDirs: string[] = [];

afterEach(() => {
  uninstallCrashHandlers();
  setCrashPhase('startup');
  resetDefaultTelemetryClientForTests();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-telemetry-'));
  tempDirs.push(dir);
  return dir;
}

class RecordingTransport implements TelemetryTransport {
  readonly sent: EnrichedTelemetryEvent[][] = [];
  readonly saved: EnrichedTelemetryEvent[][] = [];
  retryCount = 0;

  async send(events: readonly EnrichedTelemetryEvent[]): Promise<void> {
    this.sent.push([...events]);
  }

  saveToDisk(events: readonly EnrichedTelemetryEvent[]): void {
    this.saved.push([...events]);
  }

  async retryDiskEvents(): Promise<void> {
    this.retryCount += 1;
  }
}

function makeSink(transport: TelemetryTransport, flushThreshold = 10): EventSink {
  return new EventSink({
    transport,
    context: {
      appName: 'kimi-code-cli',
      version: '1.2.3',
      uiMode: 'shell',
      model: 'kimi-k2',
      env: {},
      terminal: 'test-terminal',
      locale: 'en_US',
    },
    flushThreshold,
  });
}

function sampleEvent(name = 'started'): EnrichedTelemetryEvent {
  return {
    event_id: 'event-1',
    device_id: 'device-1',
    session_id: 'session-1',
    event: name,
    timestamp: 123,
    properties: {
      resumed: false,
      count: 2,
    },
    context: {
      version: '1.2.3',
      runtime: 'node',
    },
  };
}

describe('TelemetryClient', () => {
  it('queues events before sink attach, then drains with backfilled context ids', async () => {
    const client = new TelemetryClient();
    client.track('early');
    client.setContext({ deviceId: 'dev', sessionId: 'ses' });
    const transport = new RecordingTransport();

    client.attachSink(makeSink(transport));
    await client.flush();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.[0]).toMatchObject({
      event: 'early',
      device_id: 'dev',
      session_id: 'ses',
    });
  });

  it('records scoped session ids without mutating the parent context', async () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.setContext({ deviceId: 'dev', sessionId: 'active' });
    client.attachSink(makeSink(transport));

    client.withContext({ sessionId: 'session-a' }).track('scoped');
    client.track('root');
    await client.flush();

    expect(transport.sent[0]).toMatchObject([
      { event: 'scoped', device_id: 'dev', session_id: 'session-a' },
      { event: 'root', device_id: 'dev', session_id: 'active' },
    ]);
  });

  it('can clear the active session context', async () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.setContext({ deviceId: 'dev', sessionId: 'active' });
    client.attachSink(makeSink(transport));

    client.setContext({ sessionId: null });
    client.track('no_session');
    await client.flush();

    expect(transport.sent[0]?.[0]).toMatchObject({
      event: 'no_session',
      device_id: 'dev',
      session_id: null,
    });
  });

  it('forwards directly to the attached sink and can be disabled', async () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));

    client.track('before_disable');
    client.disable();
    client.track('after_disable');
    await client.flush();

    expect(transport.sent).toHaveLength(0);
  });

  it('drops unsafe numeric properties before enqueueing events', async () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));

    client.track('big_number', { big: 2 ** 64, keep: true });
    await client.flush();

    const event = transport.sent[0]?.[0];
    if (event === undefined) throw new Error('Expected a telemetry event');
    expect(event.event).toBe('big_number');
    expect(event.properties).not.toHaveProperty('big');
    expect(event.properties['keep']).toBe(true);
  });

  it('stops the previous system metrics collector when replacing it', () => {
    const client = new TelemetryClient();
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };

    client.setSystemMetricsCollector(first);
    client.setSystemMetricsCollector(second);
    client.disable();

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it('flushes the previous sink synchronously when replacing sinks', () => {
    const client = new TelemetryClient();
    const first = new RecordingTransport();
    const second = new RecordingTransport();
    client.attachSink(makeSink(first));
    client.track('old_sink');

    client.attachSink(makeSink(second));

    expect(first.saved[0]?.[0]?.event).toBe('old_sink');
    expect(second.saved).toHaveLength(0);
  });

  it('caps the pre-sink queue at 1000 events and keeps the newest entries', async () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();

    for (let i = 0; i < 1005; i++) {
      client.track(`queued_${String(i)}`);
    }

    client.attachSink(makeSink(transport, 2000));
    await client.flush();

    expect(transport.sent[0]).toHaveLength(1000);
    expect(transport.sent[0]?.[0]?.event).toBe('queued_5');
    expect(transport.sent[0]?.at(-1)?.event).toBe('queued_1004');
  });

  it('emits generated ids and second-resolution timestamps on tracked events', async () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    const before = Date.now() / 1000;

    client.track('timed');
    await client.flush();

    const event = transport.sent[0]?.[0];
    expect(event?.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event?.timestamp).toBeGreaterThanOrEqual(before);
    expect(event?.timestamp).toBeLessThanOrEqual(Date.now() / 1000);
    expect(event?.properties).toEqual({});
  });
});

describe('SystemMetricsCollector', () => {
  it('emits a numeric system_metrics sample after the warmup delay', () => {
    vi.useFakeTimers();
    const tracked: Array<{
      event: string;
      properties: Record<string, number | string | boolean | undefined | null>;
    }> = [];
    const client = {
      track(
        event: string,
        properties: Record<string, number | string | boolean | undefined | null> = {},
      ): void {
        tracked.push({ event, properties });
      },
    };
    const collector = new SystemMetricsCollector({
      client,
      intervalMs: 30_000,
      warmupSampleMs: 1_500,
    });

    collector.start();
    vi.advanceTimersByTime(1_499);
    expect(tracked).toHaveLength(0);

    vi.advanceTimersByTime(1);
    collector.stop();

    expect(tracked).toHaveLength(1);
    const event = tracked[0];
    if (event === undefined) throw new Error('Expected a system_metrics event');
    expect(event.event).toBe('system_metrics');
    expect(numberProperty(event.properties, 'process_started_at')).toBeGreaterThan(0);
    expect(numberProperty(event.properties, 'process_uptime_ms')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'rss_bytes')).toBeGreaterThan(0);
    expect(numberProperty(event.properties, 'heap_used_bytes')).toBeGreaterThan(0);
    expect(numberProperty(event.properties, 'heap_total_bytes')).toBeGreaterThan(0);
    expect(numberProperty(event.properties, 'external_bytes')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'array_buffers_bytes')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'cpu_user_us')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'cpu_system_us')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'cpu_elapsed_us')).toBeGreaterThan(0);
    expect(numberProperty(event.properties, 'load_avg_1m')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'free_mem_bytes')).toBeGreaterThanOrEqual(0);
    expect(numberProperty(event.properties, 'total_mem_bytes')).toBeGreaterThan(0);
    expect(numberProperty(event.properties, 'cpu_count')).toBeGreaterThanOrEqual(1);
  });

  it('omits constrained_memory_bytes when it is not a safe non-negative integer', () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'constrainedMemory').mockReturnValue(2 ** 64);
    const tracked: Array<{
      event: string;
      properties: Record<string, number | string | boolean | undefined | null>;
    }> = [];
    const client = {
      track(
        event: string,
        properties: Record<string, number | string | boolean | undefined | null> = {},
      ): void {
        tracked.push({ event, properties });
      },
    };
    const collector = new SystemMetricsCollector({
      client,
      intervalMs: 30_000,
      warmupSampleMs: 1_500,
    });

    collector.start();
    vi.advanceTimersByTime(1_500);
    collector.stop();

    expect(tracked).toHaveLength(1);
    const event = tracked[0];
    if (event === undefined) throw new Error('Expected a system_metrics event');
    expect(event.event).toBe('system_metrics');
    expect(event.properties).not.toHaveProperty('constrained_memory_bytes');
    expect(numberProperty(event.properties, 'rss_bytes')).toBeGreaterThan(0);
  });

  it('reports constrained_memory_bytes when it is a safe non-negative integer', () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'constrainedMemory').mockReturnValue(8 * 1024 ** 3);
    const tracked: Array<{
      event: string;
      properties: Record<string, number | string | boolean | undefined | null>;
    }> = [];
    const client = {
      track(
        event: string,
        properties: Record<string, number | string | boolean | undefined | null> = {},
      ): void {
        tracked.push({ event, properties });
      },
    };
    const collector = new SystemMetricsCollector({
      client,
      intervalMs: 30_000,
      warmupSampleMs: 1_500,
    });

    collector.start();
    vi.advanceTimersByTime(1_500);
    collector.stop();

    expect(tracked).toHaveLength(1);
    const event = tracked[0];
    if (event === undefined) throw new Error('Expected a system_metrics event');
    expect(event.properties['constrained_memory_bytes']).toBe(8 * 1024 ** 3);
  });

  it('does not duplicate interval sampling when started twice', () => {
    vi.useFakeTimers();
    const tracked: string[] = [];
    const client = {
      track(event: string): void {
        tracked.push(event);
      },
    };
    const collector = new SystemMetricsCollector({
      client,
      intervalMs: 30_000,
      warmupSampleMs: null,
    });

    collector.start();
    collector.start();
    vi.advanceTimersByTime(30_000);
    collector.stop();

    expect(tracked).toEqual(['system_metrics']);
  });
});

describe('EventSink', () => {
  it('enriches context without mutating the original event', () => {
    const transport = new RecordingTransport();
    const sink = makeSink(transport);
    const event: TelemetryEvent = {
      event_id: 'e1',
      device_id: 'dev',
      session_id: 'ses',
      event: 'test',
      timestamp: 1,
      properties: {},
    };

    sink.accept(event);
    sink.flushSync();

    expect('context' in event).toBe(false);
    expect(transport.saved[0]?.[0]?.context).toMatchObject({
      app_name: 'kimi-code-cli',
      version: '1.2.3',
      runtime: 'node',
      ui_mode: 'shell',
      model: 'kimi-k2',
      terminal: 'test-terminal',
    });
  });

  it('delegates retry of disk events to its transport', async () => {
    const transport = new RecordingTransport();
    const sink = makeSink(transport);

    await sink.retryDiskEvents();

    expect(transport.retryCount).toBe(1);
  });
});

describe('payload assembly', () => {
  it('adds server event prefix, payload user id, and flattened fields', () => {
    const payload = buildPayload([sampleEvent('started')], 'device-1');

    expect(payload.user_id).toBe('kfc_device_id_device-1');
    expect(payload.events[0]).toMatchObject({
      event_id: 'event-1',
      device_id: 'device-1',
      session_id: 'session-1',
      event: `${SERVER_EVENT_PREFIX}started`,
      property_resumed: false,
      property_count: 2,
      context_version: '1.2.3',
      context_runtime: 'node',
    });
    expect(payload.events[0]).not.toHaveProperty('properties');
    expect(payload.events[0]).not.toHaveProperty('context');
  });

  it('does not double-prefix already-prefixed events', () => {
    const payload = buildPayload([sampleEvent('kfc_started')], 'device-1');

    expect(payload.events[0]?.['event']).toBe('kfc_started');
  });

  it('rejects nested property values before outbound send', () => {
    const event = {
      ...sampleEvent('bad'),
      properties: {
        nested: { nope: true },
      },
    } as unknown as EnrichedTelemetryEvent;

    expect(() => buildPayload([event], 'device-1')).toThrow(/property.nested/);
  });

  it('rejects unsafe numeric property values before outbound send', () => {
    const event = {
      ...sampleEvent('bad_number'),
      properties: {
        big: 2 ** 64,
      },
    };

    expect(() => buildPayload([event], 'device-1')).toThrow(/property.big/);
  });

  it('rejects nested context and array property values before outbound send', () => {
    const nestedContext = {
      ...sampleEvent('bad_context'),
      context: {
        nested: { nope: true },
      },
    } as unknown as EnrichedTelemetryEvent;
    const arrayProperty = {
      ...sampleEvent('bad_array'),
      properties: {
        list: ['nope'],
      },
    } as unknown as EnrichedTelemetryEvent;

    expect(() => buildPayload([nestedContext], 'device-1')).toThrow(/context.nested/);
    expect(() => buildPayload([arrayProperty], 'device-1')).toThrow(/property.list/);
  });

  it('passes null primitive values through and leaves the input event untouched', () => {
    const event = {
      ...sampleEvent('nullable'),
      properties: {
        empty: null,
      },
    };
    const originalProperties = event.properties;
    const originalContext = event.context;

    const payload = buildPayload([event], 'device-1');

    expect(payload.events[0]).toMatchObject({
      event: 'kfc_nullable',
      property_empty: null,
    });
    expect(event.properties).toBe(originalProperties);
    expect(event.context).toBe(originalContext);
    expect(event.event).toBe('nullable');
  });
});

describe('server prefix application', () => {
  it('locks the outbound telemetry prefixes', () => {
    expect(SERVER_EVENT_PREFIX).toBe('kfc_');
    expect(USER_ID_PREFIX).toBe('kfc_device_id_');
  });

  it('returns a new object only when adding the server prefix', () => {
    const event = sampleEvent('started');

    const prefixed = applyServerPrefix(event);

    expect(prefixed).not.toBe(event);
    expect(prefixed.event).toBe('kfc_started');
    expect(event.event).toBe('started');
  });

  it('passes already-prefixed and invalid event names through unchanged', () => {
    const prefixed = sampleEvent('kfc_started');
    const emptyName = sampleEvent('');
    const missingName = { ...sampleEvent('missing') } as unknown as Record<string, unknown>;
    delete missingName['event'];
    const numberName = {
      ...sampleEvent('number'),
      event: 123,
    } as unknown as EnrichedTelemetryEvent;

    expect(applyServerPrefix(prefixed)).toBe(prefixed);
    expect(applyServerPrefix(emptyName as unknown as EnrichedTelemetryEvent)).toBe(emptyName);
    expect(applyServerPrefix(missingName as unknown as EnrichedTelemetryEvent)).toBe(missingName);
    expect(applyServerPrefix(numberName)).toBe(numberName);
  });
});

describe('AsyncTransport', () => {
  it('locks the retry backoff schedule', () => {
    expect(RETRY_BACKOFFS_MS).toEqual([1_000, 4_000, 16_000]);
  });

  it('sends the outbound payload with bearer token when available', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const transport = new AsyncTransport({
      homeDir: await tempHome(),
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      getAccessToken: () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent()]);

    const init = requestInitFrom(fetchImpl);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-1' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      user_id: 'kfc_device_id_dev',
    });
  });

  it('retries anonymously on 401 with a token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const transport = new AsyncTransport({
      homeDir: await tempHome(),
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      getAccessToken: () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent()]);

    const first = requestInitFrom(fetchImpl);
    const second = requestInitFrom(fetchImpl, 1);
    expect(first.headers).toMatchObject({ Authorization: 'Bearer token-1' });
    expect(second.headers).not.toHaveProperty('Authorization');
  });

  it('spools to disk when the anonymous 401 retry gets a transient response', async () => {
    const homeDir = await tempHome();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      getAccessToken: () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent('anonymous_retry_server_error')]);

    const first = requestInitFrom(fetchImpl);
    const second = requestInitFrom(fetchImpl, 1);
    expect(first.headers).toMatchObject({ Authorization: 'Bearer token-1' });
    expect(second.headers).not.toHaveProperty('Authorization');
    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    expect(file).toContain('"event":"anonymous_retry_server_error"');
  });

  it('drops events when the anonymous 401 retry gets a non-retryable 4xx', async () => {
    const homeDir = await tempHome();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }));
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      getAccessToken: () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent('anonymous_retry_forbidden')]);

    const first = requestInitFrom(fetchImpl);
    const second = requestInitFrom(fetchImpl, 1);
    expect(first.headers).toMatchObject({ Authorization: 'Bearer token-1' });
    expect(second.headers).not.toHaveProperty('Authorization');
    expect(() => statSync(join(homeDir, 'telemetry'))).toThrow();
  });

  it('spools transient failures to disk after retries exhaust', async () => {
    const homeDir = await tempHome();
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent('rate_limited')]);

    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    expect(file).toContain('"event":"rate_limited"');
  });

  it('drops non-retryable 4xx responses without disk fallback', async () => {
    const homeDir = await tempHome();
    const fetchImpl = vi.fn(async () => new Response('', { status: 422 }));
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent('bad_schema')]);

    expect(() => statSync(join(homeDir, 'telemetry'))).toThrow();
  });

  it('retries disk events through the outbound pipeline and deletes the file on success', async () => {
    const homeDir = await tempHome();
    const telemetryDir = join(homeDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const file = join(telemetryDir, 'failed_retry.jsonl');
    writeFileSync(file, `${JSON.stringify(sampleEvent('from_disk'))}\n`);
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await transport.retryDiskEvents();

    const init = requestInitFrom(fetchImpl);
    const payload = JSON.parse(init.body as string) as { events: Array<{ event: string }> };
    expect(payload.events[0]?.['event']).toBe('kfc_from_disk');
    expect(() => statSync(file)).toThrow();
  });

  it('removes expired and corrupted disk files', async () => {
    const homeDir = await tempHome();
    const telemetryDir = join(homeDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const expired = join(telemetryDir, 'failed_expired.jsonl');
    const corrupt = join(telemetryDir, 'failed_corrupt.jsonl');
    writeFileSync(expired, `${JSON.stringify(sampleEvent('old'))}\n`);
    writeFileSync(corrupt, 'not json\n');
    const now = Date.now();
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => now + DISK_EVENT_MAX_AGE_MS + 1,
    });

    await transport.retryDiskEvents();

    expect(() => statSync(expired)).toThrow();
    expect(() => statSync(corrupt)).toThrow();
  });

  it('saves events before propagating shutdown aborts', async () => {
    const homeDir = await tempHome();
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: vi.fn(async () => {
        throw new TransientTelemetryError('nope');
      }) as unknown as typeof fetch,
      retryBackoffsMs: [10_000],
    });
    const controller = new AbortController();
    const send = transport.send([sampleEvent('aborted')], controller.signal);

    controller.abort();
    await expect(send).rejects.toThrow();

    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    expect(file).toContain('"event":"aborted"');
  });

  it('saves events when shutdown aborts during retry backoff', async () => {
    const homeDir = await tempHome();
    const controller = new AbortController();
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch,
      retryBackoffsMs: [10_000],
      sleep: async () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });

    await expect(
      transport.send([sampleEvent('aborted_backoff')], controller.signal),
    ).rejects.toThrow();

    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    expect(file).toContain('"event":"aborted_backoff"');
  });

  it('writes one JSONL line per event and keeps raw event names on disk fallback', async () => {
    const homeDir = await tempHome();
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      retryBackoffsMs: [],
    });

    await transport.send([sampleEvent('first'), sampleEvent('second')]);

    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    const lines = file.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!) as Record<string, unknown>).toMatchObject({
      event: 'first',
      properties: { resumed: false, count: 2 },
    });
    expect(file).not.toContain('user_id');
    expect(file).not.toContain('kfc_first');
  });

  it('does not create a disk file for an empty batch or a schema violation', async () => {
    const homeDir = await tempHome();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const transport = new AsyncTransport({
      homeDir,
      deviceId: 'dev',
      endpoint: 'https://mock.test/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    transport.saveToDisk([]);
    await transport.send([
      {
        ...sampleEvent('bad_schema'),
        properties: { nested: { nope: true } },
      } as unknown as EnrichedTelemetryEvent,
    ]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => statSync(join(homeDir, 'telemetry'))).toThrow();
  });
});

describe('telemetry bootstrap', () => {
  it('matches the KIMI_DISABLE_TELEMETRY true-value semantics', () => {
    expect(isTelemetryDisabledByEnv({ KIMI_DISABLE_TELEMETRY: '1' })).toBe(true);
    expect(isTelemetryDisabledByEnv({ KIMI_DISABLE_TELEMETRY: 'yes' })).toBe(true);
    expect(isTelemetryDisabledByEnv({ KIMI_DISABLE_TELEMETRY: '0' })).toBe(false);
    expect(isTelemetryDisabledByEnv({ KIMI_DISABLE_TELEMETRY: 'false' })).toBe(false);
  });

  it('disables the singleton without attaching a sink when opted out', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const saved = process.env['KIMI_DISABLE_TELEMETRY'];
    try {
      process.env['KIMI_DISABLE_TELEMETRY'] = 'true';
      initializeTelemetry({
        homeDir: await tempHome(),
        deviceId: 'dev',
        appName: 'kimi-code-cli',
        version: '1.2.3',
      });
      track('dropped');
      await shutdownTelemetry();
    } finally {
      if (saved === undefined) delete process.env['KIMI_DISABLE_TELEMETRY'];
      else process.env['KIMI_DISABLE_TELEMETRY'] = saved;
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('queues singleton track calls before initialization, then flushes after bootstrap', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);

    track('before_init');
    initializeTelemetry({
      homeDir: await tempHome(),
      deviceId: 'dev',
      sessionId: 'ses',
      appName: 'kimi-code-cli',
      version: '1.2.3',
    });

    await shutdownTelemetry();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = requestInitFrom(fetchImpl);
    const payload = JSON.parse(init.body as string) as {
      events: Array<{ event: string; session_id: string }>;
    };
    expect(payload.events[0]).toMatchObject({
      event: 'kfc_before_init',
      session_id: 'ses',
    });
  });

  it('flushes the singleton synchronously to disk fallback', async () => {
    const homeDir = await tempHome();
    initializeTelemetry({
      homeDir,
      deviceId: 'dev',
      sessionId: 'ses',
      appName: 'kimi-code-cli',
      version: '1.2.3',
    });
    track('sync_flush');

    flushTelemetrySync();

    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    expect(file).toContain('"event":"sync_flush"');
  });

  it('writes system metrics with the singleton session context', async () => {
    vi.useFakeTimers();
    const homeDir = await tempHome();
    initializeTelemetry({
      homeDir,
      deviceId: 'dev',
      sessionId: 'ses',
      appName: 'kimi-code-cli',
      version: '1.2.3',
    });

    vi.advanceTimersByTime(1_500);
    flushTelemetrySync();

    const telemetryDir = join(homeDir, 'telemetry');
    const file = readFileSync(join(telemetryDir, readdirOne(telemetryDir)), 'utf-8');
    const events = file
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            session_id: string | null;
            properties: Record<string, number>;
          },
      );
    const metrics = events.find((event) => event.event === 'system_metrics');
    if (metrics === undefined) throw new Error('Expected a system_metrics event');

    expect(metrics.session_id).toBe('ses');
    expect(Number.isFinite(metrics.properties['process_started_at'])).toBe(true);
    expect(metrics.properties['process_started_at']).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.properties['process_uptime_ms'])).toBe(true);
    expect(metrics.properties['process_uptime_ms']).toBeGreaterThanOrEqual(0);
    expect(metrics.properties['rss_bytes']).toBeGreaterThan(0);
  });
});

describe('crash handler', () => {
  it('records uncaught exception monitor crashes and flushes synchronously', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    setCrashPhase('runtime');
    installCrashHandlersForClient(client);

    (process.emit as (event: string, ...args: unknown[]) => boolean)(
      'uncaughtExceptionMonitor',
      new Error('boom'),
      'uncaughtException',
    );

    expect(transport.saved[0]?.[0]).toMatchObject({
      event: 'crash',
      properties: {
        error_type: 'Error',
        where: 'runtime',
        source: 'uncaughtException',
      },
    });
  });

  it('records unhandled rejection crashes and flushes synchronously', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    setCrashPhase('runtime');
    installCrashHandlersForClient(client);

    emitCrash(new TypeError('promise failed'), 'unhandledRejection');

    expect(transport.saved[0]?.[0]).toMatchObject({
      event: 'crash',
      properties: {
        error_type: 'TypeError',
        where: 'runtime',
        source: 'unhandledRejection',
      },
    });
  });

  it('keeps Node default non-zero exit semantics for unhandled rejections', async () => {
    const status = await runTelemetryCrashScript(`
      installCrashHandlersForClient(new TelemetryClient());
      Promise.reject(new TypeError('promise failed'));
      setTimeout(() => process.exit(0), 50);
    `);

    expect(status).not.toBe(0);
  });

  it('records Node-wrapped non-error unhandled rejection crashes', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    installCrashHandlersForClient(client);

    const error = Object.assign(new Error('promise failed'), {
      name: 'UnhandledPromiseRejection',
    });
    emitCrash(error, 'unhandledRejection');

    expect(transport.saved[0]?.[0]).toMatchObject({
      event: 'crash',
      properties: {
        error_type: 'UnhandledPromiseRejection',
        where: 'startup',
        source: 'unhandledRejection',
      },
    });
  });

  it('reflects startup, runtime, and shutdown phases in crash telemetry', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    installCrashHandlersForClient(client);

    for (const phase of ['startup', 'runtime', 'shutdown'] as const) {
      setCrashPhase(phase);
      emitCrash(new Error(phase));
    }

    expect(transport.saved.map((batch) => batch[0]?.properties['where'])).toEqual([
      'startup',
      'runtime',
      'shutdown',
    ]);
  });

  it('does not register duplicate listeners when installed twice', () => {
    const client = new TelemetryClient();
    const beforeUncaught = process.listenerCount('uncaughtExceptionMonitor');
    const beforeRejection = process.listenerCount('unhandledRejection');

    const uninstallFirst = installCrashHandlersForClient(client);
    const uninstallSecond = installCrashHandlersForClient(client);

    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1);
    uninstallSecond();
    uninstallFirst();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(beforeUncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection);
  });

  it('observes and records unhandled rejections when another handler owns the lifecycle', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    setCrashPhase('runtime');
    installCrashHandlersForClient(client);
    // The TUI registers its own rejection handler; while one exists the
    // crash handler must observe (not rethrow) so the lifecycle is untouched.
    const owner = (): void => {};
    process.on('unhandledRejection', owner);
    try {
      (process.emit as (event: string, ...args: unknown[]) => boolean)(
        'unhandledRejection',
        new TypeError('promise failed'),
        Promise.resolve(),
      );
    } finally {
      process.off('unhandledRejection', owner);
    }

    expect(transport.saved[0]?.[0]).toMatchObject({
      event: 'crash',
      properties: {
        error_type: 'TypeError',
        where: 'runtime',
        source: 'unhandledRejection',
      },
    });
  });

  it('ignores aborted-operation rejections while observing', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    installCrashHandlersForClient(client);
    const owner = (): void => {};
    process.on('unhandledRejection', owner);
    try {
      (process.emit as (event: string, ...args: unknown[]) => boolean)(
        'unhandledRejection',
        new DOMException('The operation was aborted.', 'AbortError'),
        Promise.resolve(),
      );
    } finally {
      process.off('unhandledRejection', owner);
    }

    expect(transport.saved).toHaveLength(0);
  });

  it('rethrows when it is the only rejection listener, recording the crash exactly once', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    setCrashPhase('runtime');
    // Vitest keeps its own rejection listeners; temporarily drop every
    // listener so the crash handler is the sole one, as in print/server mode.
    const others = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    installCrashHandlersForClient(client);
    const reason = new TypeError('promise failed');
    try {
      expect(() =>
        (process.emit as (event: string, ...args: unknown[]) => boolean)(
          'unhandledRejection',
          reason,
          Promise.resolve(),
        ),
      ).toThrow(reason);

      // Tracked once as a rejection; when the rethrow later surfaces at the
      // uncaughtException monitor it must not be reported a second time.
      expect(transport.saved[0]?.[0]).toMatchObject({
        event: 'crash',
        properties: {
          error_type: 'TypeError',
          where: 'runtime',
          source: 'unhandledRejection',
        },
      });
      emitCrash(reason);
      expect(transport.saved).toHaveLength(1);
    } finally {
      uninstallCrashHandlers();
      for (const listener of others) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void);
      }
    }
  });

  it('dedupes rethrown non-Error rejection reasons at the uncaught monitor', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    setCrashPhase('runtime');
    const others = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    installCrashHandlersForClient(client);
    const reason = { code: 'E' };
    try {
      let caught: unknown;
      try {
        (process.emit as (event: string, ...args: unknown[]) => boolean)(
          'unhandledRejection',
          reason,
          Promise.resolve(),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(reason);

      // The plain-object reason is rethrown through the monitor; it must be
      // deduped there, not reported as a second crash.
      (process.emit as (event: string, ...args: unknown[]) => boolean)(
        'uncaughtExceptionMonitor',
        reason,
        'uncaughtException',
      );
      expect(transport.saved).toHaveLength(1);
      expect(transport.saved[0]?.[0]).toMatchObject({
        event: 'crash',
        properties: {
          error_type: 'object',
          where: 'runtime',
          source: 'unhandledRejection',
        },
      });
    } finally {
      uninstallCrashHandlers();
      for (const listener of others) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void);
      }
    }
  });

  it('dedupes null rejection reasons and classifies monitor crashes null-safely', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    setCrashPhase('runtime');
    const others = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    installCrashHandlersForClient(client);
    try {
      let caught: unknown = 'not-thrown';
      try {
        (process.emit as (event: string, ...args: unknown[]) => boolean)(
          'unhandledRejection',
          null,
          Promise.resolve(),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(null);

      // The rethrown null reaches the monitor: deduped, and the error-type
      // classification must not itself throw on null/undefined.
      expect(() => {
        emitCrash(null as unknown as Error);
      }).not.toThrow();
      expect(transport.saved).toHaveLength(1);
      expect(transport.saved[0]?.[0]).toMatchObject({
        event: 'crash',
        properties: {
          error_type: 'object',
          where: 'runtime',
          source: 'unhandledRejection',
        },
      });
    } finally {
      uninstallCrashHandlers();
      for (const listener of others) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void);
      }
    }
  });

  it('ignores aborted-operation errors', () => {
    const client = new TelemetryClient();
    const transport = new RecordingTransport();
    client.attachSink(makeSink(transport));
    installCrashHandlersForClient(client);

    emitCrash(new DOMException('The operation was aborted.', 'AbortError'));
    emitCrash(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    emitCrash(new DOMException('The operation was aborted.', 'AbortError'), 'unhandledRejection');
    emitCrash(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      'unhandledRejection',
    );

    expect(transport.saved).toHaveLength(0);
  });
});

function readdirOne(dir: string): string {
  const entry = readdirSync(dir)[0];
  if (entry === undefined) throw new Error(`No files in ${dir}`);
  return entry;
}

function numberProperty(
  properties: Record<string, number | string | boolean | undefined | null>,
  key: string,
): number {
  const value = properties[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected property ${key} to be a finite number, got ${String(value)}`);
  }
  return value;
}

function requestInitFrom(
  fetchImpl: { readonly mock: { readonly calls: readonly unknown[][] } },
  index = 0,
): RequestInit {
  const call = fetchImpl.mock.calls[index] as readonly [unknown, RequestInit?] | undefined;
  const init = call?.[1];
  if (init === undefined) throw new Error(`No request init for fetch call ${String(index)}`);
  return init;
}

function emitCrash(
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin = 'uncaughtException',
): void {
  (process.emit as (event: string, ...args: unknown[]) => boolean)(
    'uncaughtExceptionMonitor',
    error,
    origin,
  );
}

async function runTelemetryCrashScript(body: string): Promise<number> {
  const dir = await tempHome();
  const scriptPath = join(dir, 'crash-worker.ts');
  const testDir = import.meta.dirname;
  const tsxCli = join(
    dirname(fileURLToPath(import.meta.resolve('tsx/package.json'))),
    'dist/cli.mjs',
  );
  const crashModuleUrl = pathToFileURL(join(testDir, '../src/crash.ts')).href;
  const clientModuleUrl = pathToFileURL(join(testDir, '../src/client.ts')).href;
  writeFileSync(
    scriptPath,
    `
      import { TelemetryClient } from ${JSON.stringify(clientModuleUrl)};
      import { installCrashHandlersForClient } from ${JSON.stringify(crashModuleUrl)};

      ${body}
    `,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, scriptPath], {
      cwd: join(testDir, '../../..'),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === null) {
        reject(new Error(`Crash script exited without a code: ${stderr}`));
        return;
      }
      resolve(code);
    });
  });
}
