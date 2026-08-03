import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { CloudAppender, type CloudAppenderOptions } from '#/app/telemetry/cloudAppender';

import { stubBootstrap } from '../bootstrap/stubs';

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly user_id: string;
    readonly events: readonly Record<string, unknown>[];
  };
}

type Responder = (req: CapturedRequest) => Response | Promise<Response>;

function makeFetch(responder: Responder): typeof fetch {
  return (async (input: unknown, init: unknown) => {
    const requestInit = init as { headers: Record<string, string>; body: string };
    const req: CapturedRequest = {
      url: String(input),
      headers: requestInit.headers,
      body: JSON.parse(requestInit.body) as CapturedRequest['body'],
    };
    return responder(req);
  }) as unknown as typeof fetch;
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

function baseOptions(
  overrides: Partial<CloudAppenderOptions> & { homeDir?: string } = {},
): CloudAppenderOptions {
  const { homeDir: dir = '', storage, ...rest } = overrides;
  return {
    storage: storage ?? new FileStorageService(dir),
    bootstrap: { ...stubBootstrap(), clientVersion: '1.0.0' },
    deviceId: 'dev',
    appName: 'test-app',
    sleep: async () => {},
    ...rest,
  };
}

describe('CloudAppender', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cloud-appender-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('sends a flattened, prefixed payload with user_id and context', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        sessionId: 'sess1',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track('tool.call', { name: 'bash', count: 2 });
    await appender.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.com/v1/event');
    expect(requests[0]?.body.user_id).toBe('kfc_device_id_dev123');
    const event = requests[0]?.body.events[0];
    expect(event?.['event']).toBe('kfc_tool.call');
    expect(event?.['device_id']).toBe('dev123');
    expect(event?.['session_id']).toBe('sess1');
    expect(event?.['property_name']).toBe('bash');
    expect(event?.['property_count']).toBe(2);
    expect(event?.['context_app_name']).toBe('test-app');
    expect(event?.['context_client_version']).toBe('1.0.0');
    expect(event?.['context_version']).toBe('1.0.0');
    expect(typeof event?.['context_core_version']).toBe('string');
    expect(typeof event?.['event_id']).toBe('string');
    expect(typeof event?.['timestamp']).toBe('number');
  });

  it('applies setContext sessionId and model updates to subsequent events', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        model: 'initial-model',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.setContext({ sessionId: 'sess42', model: 'switched-model' });
    appender.track('turn_started', {});
    await appender.flush();

    const event = requests[0]?.body.events[0];
    expect(event?.['session_id']).toBe('sess42');
    expect(event?.['context_model']).toBe('switched-model');
  });

  it('uses the event sessionId for top-level session_id when it differs from appender context', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        sessionId: 'default-session',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track('evt', { sessionId: 'event-session' });
    await appender.flush();

    expect(requests[0]?.body.events[0]?.['session_id']).toBe('event-session');
  });

  it('sends Authorization header when a token is provided', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        getAccessToken: () => 'tok123',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track('evt');
    await appender.flush();

    expect(requests[0]?.headers['Authorization']).toBe('Bearer tok123');
  });

  it('auto-flushes when the buffer reaches the threshold', async () => {
    let sends = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        flushThreshold: 3,
        fetchImpl: makeFetch(() => {
          sends += 1;
          return okResponse();
        }),
      }),
    );

    appender.track('e1');
    appender.track('e2');
    expect(sends).toBe(0);
    appender.track('e3');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(1);
  });

  it('shutdown flushes the remaining buffered events', async () => {
    let sends = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          sends += 1;
          return okResponse();
        }),
      }),
    );

    appender.track('e1');
    await appender.shutdown();
    expect(sends).toBe(1);
  });

  it('retries on 5xx and saves to disk after exhausting backoffs', async () => {
    let attempts = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          attempts += 1;
          return statusResponse(500);
        }),
      }),
    );

    appender.track('evt');
    await appender.flush();

    expect(attempts).toBe(4);
    const files = readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_'));
    expect(files).toHaveLength(1);
  });

  it('retries a 401 once without the Authorization header', async () => {
    const seenAuths: (string | undefined)[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        getAccessToken: () => 'tok',
        fetchImpl: makeFetch((req) => {
          seenAuths.push(req.headers['Authorization']);
          if (req.headers['Authorization'] !== undefined) {
            return statusResponse(401);
          }
          return okResponse();
        }),
      }),
    );

    appender.track('evt');
    await appender.flush();

    expect(seenAuths).toEqual(['Bearer tok', undefined]);
  });

  it('retryDiskEvents resends saved events and removes the file on success', async () => {
    let shouldFail = true;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => (shouldFail ? statusResponse(500) : okResponse())),
      }),
    );

    appender.track('evt');
    await appender.flush();
    expect(
      readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_')),
    ).toHaveLength(1);

    shouldFail = false;
    await appender.retryDiskEvents();
    expect(
      readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_')),
    ).toHaveLength(0);
  });

  it('drops non-primitive properties and reports the violation', async () => {
    const errors: unknown[] = [];
    setUnexpectedErrorHandler((err) => errors.push(err));
    try {
      const requests: CapturedRequest[] = [];
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          fetchImpl: makeFetch((req) => {
            requests.push(req);
            return okResponse();
          }),
        }),
      );

      appender.track('evt', { ok: 'yes', bad: { nested: true } as unknown as string });
      await appender.flush();

      const event = requests[0]?.body.events[0];
      expect(event?.['property_ok']).toBe('yes');
      expect(event?.['property_bad']).toBeUndefined();
      expect(errors).toHaveLength(1);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  describe('shutdown durability', () => {
    it('serializes concurrent flush calls without losing events', async () => {
      const requests: CapturedRequest[] = [];
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          fetchImpl: makeFetch((req) => {
            requests.push(req);
            return okResponse();
          }),
        }),
      );

      // Track multiple events
      appender.track('e1');
      appender.track('e2');
      appender.track('e3');

      // Fire multiple concurrent flushes — they must serialize, not race
      await Promise.all([appender.flush(), appender.flush(), appender.flush()]);

      // All events must have been sent (possibly in multiple batches, but
      // the total event count must be 3)
      const totalEvents = requests.reduce(
        (sum, req) => sum + req.body.events.length,
        0,
      );
      expect(totalEvents).toBe(3);
    });

    it('shutdown is idempotent — calling it twice only flushes once', async () => {
      let sends = 0;
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          fetchImpl: makeFetch(() => {
            sends += 1;
            return okResponse();
          }),
        }),
      );

      appender.track('e1');
      await appender.shutdown();
      await appender.shutdown(); // Second call should be a no-op
      expect(sends).toBe(1);
    });

    it('shutdown respects the deadline and hands unsent events to disk', async () => {
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          // Fetch that never resolves within the deadline
          fetchImpl: makeFetch(
            () => new Promise((resolve) => setTimeout(() => resolve(okResponse()), 10_000)),
          ),
        }),
      );

      appender.track('e1');
      appender.track('e2');

      // Shutdown with a very short deadline (already expired)
      await appender.shutdown(Date.now());

      // Events should have been saved to disk
      const files = readdirSync(join(homeDir, 'telemetry')).filter((f) =>
        f.startsWith('failed_'),
      );
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it('shutdown replays spool data from disk', async () => {
      let sends = 0;
      let shouldFail = true;
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          fetchImpl: makeFetch(() => {
            if (shouldFail) return statusResponse(500);
            sends += 1;
            return okResponse();
          }),
        }),
      );

      // First flush fails → events go to disk
      appender.track('disk_event');
      await appender.flush();
      expect(
        readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_')),
      ).toHaveLength(1);

      // Now make fetch succeed and call shutdown — it should replay disk events
      shouldFail = false;
      await appender.shutdown();

      // Disk file should be cleaned up after successful replay
      expect(
        readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_')),
      ).toHaveLength(0);
      expect(sends).toBe(1); // The replayed event was sent
    });

    it('track() after shutdown is silently ignored', async () => {
      let sends = 0;
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          fetchImpl: makeFetch(() => {
            sends += 1;
            return okResponse();
          }),
        }),
      );

      appender.track('before_shutdown');
      await appender.shutdown();
      appender.track('after_shutdown'); // Should be ignored
      expect(sends).toBe(1);
    });
  });
});
