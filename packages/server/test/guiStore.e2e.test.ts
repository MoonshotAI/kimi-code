import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-gui-store-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-gui-store-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
  };
}

function getItem(api: ReturnType<typeof appOf>, key: string) {
  return api.inject({ method: 'GET', url: `/api/v1/gui/store/getItem?key=${key}` });
}

function setItem(api: ReturnType<typeof appOf>, key: string, value: string) {
  return api.inject({
    method: 'POST',
    url: '/api/v1/gui/store/setItem',
    payload: { key, value },
  });
}

describe('gui store routes', () => {
  it('getItem returns null when the file does not exist', async () => {
    const r = await bootDaemon();
    const res = await getItem(appOf(r), 'theme');
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{ value: string | null }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.value).toBeNull();
  });

  it('setItem then getItem round-trips and persists to gui.toml', async () => {
    const r = await bootDaemon();
    const api = appOf(r);

    const setRes = await setItem(api, 'theme', 'modern');
    expect(envelopeOf<null>(setRes.json()).code).toBe(0);

    const getEnv = envelopeOf<{ value: string | null }>((await getItem(api, 'theme')).json());
    expect(getEnv.data?.value).toBe('modern');

    const text = readFileSync(join(bridgeHome, 'gui.toml'), 'utf-8');
    expect(text).toContain('theme = "modern"');
  });

  it('setItem overwrites an existing value', async () => {
    const r = await bootDaemon();
    const api = appOf(r);
    await setItem(api, 'theme', 'modern');
    await setItem(api, 'theme', 'terminal');

    const env = envelopeOf<{ value: string | null }>((await getItem(api, 'theme')).json());
    expect(env.data?.value).toBe('terminal');
  });

  it('removeItem deletes a key and leaves others intact', async () => {
    const r = await bootDaemon();
    const api = appOf(r);
    await setItem(api, 'a', '1');
    await setItem(api, 'b', '2');
    const rmRes = await api.inject({
      method: 'POST',
      url: '/api/v1/gui/store/removeItem',
      payload: { key: 'a' },
    });
    expect(envelopeOf<null>(rmRes.json()).code).toBe(0);

    expect(envelopeOf<{ value: string | null }>((await getItem(api, 'a')).json()).data?.value).toBeNull();
    expect(envelopeOf<{ value: string | null }>((await getItem(api, 'b')).json()).data?.value).toBe('2');
  });

  it('removeItem on a missing key is a no-op', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/gui/store/removeItem',
      payload: { key: 'nope' },
    });
    expect(envelopeOf<null>(res.json()).code).toBe(0);
  });

  it('length reports the count and clear empties the store', async () => {
    const r = await bootDaemon();
    const api = appOf(r);
    await setItem(api, 'a', '1');
    await setItem(api, 'b', '2');

    const before = envelopeOf<{ length: number }>(
      (await api.inject({ method: 'GET', url: '/api/v1/gui/store/length' })).json(),
    );
    expect(before.data?.length).toBe(2);

    const clearRes = await api.inject({ method: 'POST', url: '/api/v1/gui/store/clear' });
    expect(envelopeOf<null>(clearRes.json()).code).toBe(0);

    const after = envelopeOf<{ length: number }>(
      (await api.inject({ method: 'GET', url: '/api/v1/gui/store/length' })).json(),
    );
    expect(after.data?.length).toBe(0);
  });

  it('quotes dotted keys in the persisted TOML and reads them back', async () => {
    const r = await bootDaemon();
    const api = appOf(r);
    await setItem(api, 'kimi-web.theme', 'modern');

    const text = readFileSync(join(bridgeHome, 'gui.toml'), 'utf-8');
    expect(text).toContain('"kimi-web.theme" = "modern"');

    const env = envelopeOf<{ value: string | null }>((await getItem(api, 'kimi-web.theme')).json());
    expect(env.data?.value).toBe('modern');
  });

  it('rejects an empty key', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/gui/store/setItem',
      payload: { key: '', value: 'x' },
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it('treats Object.prototype keys as ordinary keys', async () => {
    const r = await bootDaemon();
    const api = appOf(r);

    // On an empty store, prototype keys must not resolve to inherited members.
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, 'toString')).json()).data?.value,
    ).toBeNull();
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, 'constructor')).json()).data?.value,
    ).toBeNull();

    // They can be set and read back like any other key, including __proto__.
    await setItem(api, 'hasOwnProperty', 'x');
    await setItem(api, '__proto__', 'y');
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, 'hasOwnProperty')).json()).data
        ?.value,
    ).toBe('x');
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, '__proto__')).json()).data?.value,
    ).toBe('y');
  });

  it('writes gui.toml with 0600 permissions', async () => {
    const r = await bootDaemon();
    await setItem(appOf(r), 'theme', 'modern');
    const mode = statSync(join(bridgeHome, 'gui.toml')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
