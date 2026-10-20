import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KIMI_REGION_PROFILES } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clientConfigsBaseUrl,
  fetchClientConfig,
  isRegisteredClientConfig,
  MODEL_SWITCH_CONFIRM_CONFIG_NAME,
} from '../src/services/clientConfigs';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('clientConfigsBaseUrl', () => {
  it('prefers the env override and strips trailing slashes', () => {
    expect(clientConfigsBaseUrl('https://example.com/coding/v1//', 'mainland-cn')).toBe(
      'https://example.com/coding/v1',
    );
  });

  it('falls back to the region profile when the override is missing or blank', () => {
    expect(clientConfigsBaseUrl(undefined, 'mainland-cn')).toBe(
      KIMI_REGION_PROFILES['mainland-cn'].baseUrl,
    );
    expect(clientConfigsBaseUrl('   ', 'global')).toBe(KIMI_REGION_PROFILES.global.baseUrl);
  });
});

describe('fetchClientConfig', () => {
  it('posts the config name and parses the envelope payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        config: {
          enable: true,
          rules: [{ from: 'kimi-k2.5', to: 'kimi-k3', hint: { en: 'heads-up', zh: '注意' } }],
        },
      }),
    );
    const config = await fetchClientConfig(
      MODEL_SWITCH_CONFIRM_CONFIG_NAME,
      'https://example.com/coding/v1',
      fetchImpl as unknown as typeof fetch,
    );
    expect(config).toEqual({
      enable: true,
      rules: [{ from: 'kimi-k2.5', to: 'kimi-k3', hint: { en: 'heads-up', zh: '注意' } }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.com/coding/v1/client_configs');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: MODEL_SWITCH_CONFIRM_CONFIG_NAME }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns undefined for an unregistered name without hitting the network', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    expect(
      await fetchClientConfig('nope', 'https://example.com', fetchImpl as unknown as typeof fetch),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns undefined when the response is not ok or the envelope mismatches', async () => {
    const notOk = vi.fn(async () => jsonResponse({}, false));
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        notOk as unknown as typeof fetch,
      ),
    ).toBeUndefined();

    const wrongName = vi.fn(async () =>
      jsonResponse({ name: 'other', config: { enable: true, rules: [] } }),
    );
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        wrongName as unknown as typeof fetch,
      ),
    ).toBeUndefined();

    const garbageBody = vi.fn(async () => jsonResponse('garbage'));
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        garbageBody as unknown as typeof fetch,
      ),
    ).toBeUndefined();
  });

  it('tolerates malformed payloads: invalid rules dropped, invalid enable falls back to false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        config: {
          enable: 'yes',
          rules: [{ from: 'a' }, { from: 'a', to: 'b' }, 'junk'],
        },
      }),
    );
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        fetchImpl as unknown as typeof fetch,
      ),
    ).toEqual({ enable: false, rules: [{ from: 'a', to: 'b' }] });

    const nonObject = vi.fn(async () =>
      jsonResponse({ name: MODEL_SWITCH_CONFIRM_CONFIG_NAME, config: 42 }),
    );
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        nonObject as unknown as typeof fetch,
      ),
    ).toEqual({ enable: false, rules: [] });
  });

  it('passes id lists through and drops rules with empty or mixed lists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        config: {
          enable: true,
          rules: [
            { from: ['a', 'b'], to: 'c' },
            { from: 'd', to: ['e', 'f'] },
            { from: [], to: 'g' },
            { from: ['a', 1], to: 'c' },
            { from: 'h', to: [1] },
          ],
        },
      }),
    );
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        fetchImpl as unknown as typeof fetch,
      ),
    ).toEqual({
      enable: true,
      rules: [
        { from: ['a', 'b'], to: 'c' },
        { from: 'd', to: ['e', 'f'] },
      ],
    });
  });

  it('returns undefined when the fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(
      await fetchClientConfig(
        MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        'https://example.com',
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBeUndefined();
  });
});

describe('server-v2 POST /api/v1/client_configs', () => {
  let server: RunningServer | undefined;
  let cloud: Server | undefined;
  let home: string | undefined;
  let base: string;
  let cloudBehavior: { status: number; body: unknown };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-client-configs-'));
    cloudBehavior = { status: 200, body: {} };
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (cloud !== undefined) {
      await new Promise<void>((resolve) => {
        cloud?.close(() => {
          resolve();
        });
      });
      cloud = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function boot(): Promise<void> {
    cloud = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf-8');
      });
      req.on('end', () => {
        res.writeHead(cloudBehavior.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(cloudBehavior.body));
        void raw;
      });
    });
    await new Promise<void>((resolve) => {
      cloud?.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const cloudPort = (cloud.address() as AddressInfo).port;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: { ...process.env, KIMI_CODE_BASE_URL: `http://127.0.0.1:${cloudPort}` },
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function postClientConfigs(
    name: string,
  ): Promise<Envelope<{ name: string; config: unknown }>> {
    const res = await fetch(`${base}/api/v1/client_configs`, {
      method: 'POST',
      headers: { ...authHeaders(server as RunningServer), 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    } as never);
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<{ name: string; config: unknown }>;
  }

  it('returns the parsed config inside the ok envelope', async () => {
    cloudBehavior = {
      status: 200,
      body: {
        name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        config: { enable: true, rules: [{ from: 'a', to: 'b', hint: { en: 'hi' } }] },
      },
    };
    await boot();
    const body = await postClientConfigs(MODEL_SWITCH_CONFIRM_CONFIG_NAME);
    expect(body.code).toBe(0);
    expect(body.msg).toBe('success');
    expect(typeof body.request_id).toBe('string');
    expect(body.data).toEqual({
      name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
      config: { enable: true, rules: [{ from: 'a', to: 'b', hint: { en: 'hi' } }] },
    });
  });

  it('fetches the cloud on every request, so config changes are picked up immediately', async () => {
    cloudBehavior = {
      status: 200,
      body: {
        name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        config: { enable: true, rules: [{ from: 'a', to: 'b' }] },
      },
    };
    await boot();
    const first = await postClientConfigs(MODEL_SWITCH_CONFIRM_CONFIG_NAME);
    expect(first.data.config).toEqual({ enable: true, rules: [{ from: 'a', to: 'b' }] });

    cloudBehavior = {
      status: 200,
      body: {
        name: MODEL_SWITCH_CONFIRM_CONFIG_NAME,
        config: { enable: true, rules: [{ from: ['a', 'c'], to: 'b' }] },
      },
    };
    const second = await postClientConfigs(MODEL_SWITCH_CONFIRM_CONFIG_NAME);
    expect(second.data.config).toEqual({ enable: true, rules: [{ from: ['a', 'c'], to: 'b' }] });
  });

  it('returns null config for an unregistered name', async () => {
    await boot();
    const body = await postClientConfigs('no_such_config');
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ name: 'no_such_config', config: null });
  });

  it('returns null config when the cloud fetch keeps failing', async () => {
    cloudBehavior = { status: 500, body: {} };
    await boot();
    const body = await postClientConfigs(MODEL_SWITCH_CONFIRM_CONFIG_NAME);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ name: MODEL_SWITCH_CONFIRM_CONFIG_NAME, config: null });
  });
});
