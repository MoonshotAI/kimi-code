import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { CloudAppender, type CloudAppenderOptions } from '#/app/telemetry/cloudAppender';

import { stubBootstrap, stubClientIdentity } from '../bootstrap/stubs';

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
  overrides: Partial<CloudAppenderOptions> & { homeDir?: string; bootstrapEnv?: NodeJS.ProcessEnv } = {},
): CloudAppenderOptions {
  const { homeDir: dir = '', storage, bootstrapEnv, ...rest } = overrides;
  return {
    storage: storage ?? new FileStorageService(dir),
    bootstrap: {
      ...stubBootstrap(dir === '' ? undefined : dir, bootstrapEnv),
      clientIdentity: { ...stubClientIdentity, version: '1.0.0' },
    },
    deviceId: 'dev',
    appName: 'test-app',
    sleep: async () => {},
    ...rest,
  };
}

describe('CloudAppender', () => {
  let homeDir: string;
  let savedOauthHost: string | undefined;
  let savedLegacyOauthHost: string | undefined;
  let savedKimiHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cloud-appender-'));
    savedOauthHost = process.env['KIMI_CODE_OAUTH_HOST'];
    savedLegacyOauthHost = process.env['KIMI_OAUTH_HOST'];
    savedKimiHome = process.env['KIMI_CODE_HOME'];
    delete process.env['KIMI_CODE_OAUTH_HOST'];
    delete process.env['KIMI_OAUTH_HOST'];
    process.env['KIMI_CODE_HOME'] = homeDir;
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    if (savedOauthHost === undefined) delete process.env['KIMI_CODE_OAUTH_HOST'];
    else process.env['KIMI_CODE_OAUTH_HOST'] = savedOauthHost;
    if (savedLegacyOauthHost === undefined) delete process.env['KIMI_OAUTH_HOST'];
    else process.env['KIMI_OAUTH_HOST'] = savedLegacyOauthHost;
    if (savedKimiHome === undefined) delete process.env['KIMI_CODE_HOME'];
    else process.env['KIMI_CODE_HOME'] = savedKimiHome;
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

    appender.track({ event: 'tool.call', context: {}, properties: { name: 'bash', count: 2 } });
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

  it('derives the global endpoint when the env pins the global region', async () => {
    process.env['KIMI_CODE_OAUTH_HOST'] = 'https://auth.kimi.ai';
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

    appender.track({ event: 'tool.call', context: {}, properties: { name: 'bash' } });
    await appender.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.ai/v1/event');
  });

  it('reads the install marker from the bootstrapped home for the default endpoint', async () => {
    writeFileSync(join(homeDir, 'region'), 'global\n');
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

    appender.track({ event: 'tool.call', context: {}, properties: { name: 'bash' } });
    await appender.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.ai/v1/event');
  });

  it('honors the marker opt-out from the bootstrap env bag (no process.env needed)', async () => {
    writeFileSync(join(homeDir, 'region'), 'global\n');
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        bootstrapEnv: { KIMI_CODE_REGION_MARKER: 'off' },
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track({ event: 'tool.call', context: {}, properties: { name: 'bash' } });
    await appender.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.com/v1/event');
  });

  it('honors KIMI_CODE_REGION_MARKER=off so embedded servers ignore the install marker', async () => {
    writeFileSync(join(homeDir, 'region'), 'global\n');
    const savedMarkerFlag = process.env['KIMI_CODE_REGION_MARKER'];
    process.env['KIMI_CODE_REGION_MARKER'] = 'off';
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

      appender.track({ event: 'tool.call', context: {}, properties: { name: 'bash' } });
      await appender.flush();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.com/v1/event');
    } finally {
      if (savedMarkerFlag === undefined) delete process.env['KIMI_CODE_REGION_MARKER'];
      else process.env['KIMI_CODE_REGION_MARKER'] = savedMarkerFlag;
    }
  });

  it('uses the ambient session_id for the top-level envelope session_id', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        sessionId: 'default-session',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track({
      event: 'turn_started',
      context: { session_id: 'ambient-session' },
      properties: { sessionId: 'ambient-session' },
    });
    await appender.flush();

    expect(requests[0]?.body.events[0]?.['session_id']).toBe('ambient-session');
    expect(requests[0]?.body.events[0]?.['property_sessionId']).toBe('ambient-session');
  });

  it('falls back to the appender static session id when ambient has none', async () => {
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

    appender.track({ event: 'turn_started', context: {}, properties: {} });
    await appender.flush();

    expect(requests[0]?.body.events[0]?.['session_id']).toBe('default-session');
  });

  it('uses the ambient model for the envelope context when constructed without a model', async () => {
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

    appender.track({ event: 'turn_started', context: { model: 'ambient-model' }, properties: {} });
    await appender.flush();

    expect(requests[0]?.body.events[0]?.['context_model']).toBe('ambient-model');
  });

  it('prefers the ambient model over the constructor model in the envelope context', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        model: 'constructor-model',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track({ event: 'turn_started', context: { model: 'ambient-model' }, properties: {} });
    await appender.flush();

    expect(requests[0]?.body.events[0]?.['context_model']).toBe('ambient-model');
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

    appender.track({ event: 'evt', context: {}, properties: {} });
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

    appender.track({ event: 'e1', context: {}, properties: {} });
    appender.track({ event: 'e2', context: {}, properties: {} });
    expect(sends).toBe(0);
    appender.track({ event: 'e3', context: {}, properties: {} });
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

    appender.track({ event: 'e1', context: {}, properties: {} });
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

    appender.track({ event: 'evt', context: {}, properties: {} });
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

    appender.track({ event: 'evt', context: {}, properties: {} });
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

    appender.track({ event: 'evt', context: {}, properties: {} });
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

  it('drops null values from the outbound payload', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track({ event: 'evt', context: {}, properties: { empty: null, keep: 'yes' } });
    await appender.flush();

    expect(requests).toHaveLength(1);
    const event = requests[0]?.body.events[0];
    expect(event?.['property_keep']).toBe('yes');
    expect(event).not.toHaveProperty('property_empty');
    expect(event).not.toHaveProperty('session_id');
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

      appender.track({
        event: 'evt',
        context: {},
        properties: { ok: 'yes', bad: { nested: true } as unknown as string },
      });
      await appender.flush();

      const event = requests[0]?.body.events[0];
      expect(event?.['property_ok']).toBe('yes');
      expect(event?.['property_bad']).toBeUndefined();
      expect(errors).toHaveLength(1);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});
