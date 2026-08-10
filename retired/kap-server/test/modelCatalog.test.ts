/**
 * Engine-mode `/api/v1/models` + `/api/v1/providers` — the catalog surface
 * projected from the Rust engine's parsed config.
 *
 * Engine-only semantics: the engine's `ModelAlias` carries only
 * `provider`/`model`/`max_tokens`, so the list route reports `display_name`
 * = alias id and a fixed `max_context_size` of 1,000,000 (no per-alias
 * window); providers are projected without a `models` array; the v2
 * discovery/refresh surface (`/catalog/*`, `/providers:refresh*`) and the
 * provider-rename (`new_id`) path are not registered on the native engine.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_TOML = [
  'defaultModel = "k2"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'apiKey = "sk-test"',
  'baseUrl = "https://api.example.test/v1"',
  '',
  '[providers.openai]',
  'type = "openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  '',
  '[models.turbo]',
  'provider = "kimi"',
  'model = "kimi-turbo"',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  '',
].join('\n');

describe('engine-mode /api/v1 model/provider catalog', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  // The Rust engine process is a module-level singleton: `KIMI_CONFIG_PATH`
  // freezes at the first spawn, so all cases share one home dir and `boot`
  // rewrites the same config file (the engine re-reads it per RPC).
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-engine-model-catalog-'));
  });

  afterAll(async () => {
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    } else {
      await rm(join(home as string, 'config.toml'), { force: true });
    }
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('lists configured model aliases (engine projection)', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    // Engine projection: the catalog merges the built-in models.dev directory
    // with the configured aliases; the configured entries are present with
    // the engine's fixed 1M window.
    expect(body.data.items).toEqual(
      expect.arrayContaining([
        {
          provider: 'kimi',
          model: 'kimi-k2',
          display_name: 'k2',
          max_context_size: 1_000_000,
        },
        {
          provider: 'kimi',
          model: 'kimi-turbo',
          display_name: 'turbo',
          max_context_size: 1_000_000,
        },
        {
          provider: 'openai',
          model: 'gpt-4o',
          display_name: 'gpt4o',
          max_context_size: 1_000_000,
        },
      ]),
    );
  });

  it('hides the synthesized secondary-model derived entry from /models', async () => {
    await boot(
      `${CATALOG_TOML}\n[secondary_model]\nmodel = "turbo"\nmax_output_size = 8192\n`,
    );
    const { status, body } = await getJson<{ items: { model: string }[] }>('/api/v1/models');
    expect(status).toBe(200);
    // The configured aliases are present; the synthesized secondary-model
    // entry must NOT appear under the reserved alias id.
    const models = body.data.items.map((item) => item.model);
    expect(models).toContain('kimi-k2');
    expect(models).toContain('kimi-turbo');
    expect(models).toContain('gpt-4o');
    expect(models).not.toContain('kimi-turbo-secondary');
  });

  it('lists providers and returns a single provider by id', async () => {
    await boot(CATALOG_TOML);
    const list = await getJson<{ items: unknown[] }>('/api/v1/providers');
    expect(list.body.code).toBe(0);
    // Engine projection: built-in models.dev providers merge with the
    // configured ones; the configured entries carry the expected shapes.
    expect(list.body.data.items).toEqual(
      expect.arrayContaining([
        {
          id: 'kimi',
          type: 'kimi',
          base_url: 'https://api.example.test/v1',
          has_api_key: true,
          status: 'connected',
        },
        {
          id: 'openai',
          type: 'openai',
          has_api_key: false,
          status: 'unconfigured',
        },
      ]),
    );

    const single = await getJson<unknown>('/api/v1/providers/kimi');
    expect(single.body.code).toBe(0);
    expect(single.body.data).toEqual({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      has_api_key: true,
      status: 'connected',
      // The single GET reveals the stored key; the list above never does.
      api_key: 'sk-test',
    });

    const noKey = await getJson<Record<string, unknown>>('/api/v1/providers/openai');
    expect(noKey.body.code).toBe(0);
    expect(noKey.body.data).not.toHaveProperty('api_key');
  });

  it('sets the global default model alias', async () => {
    await boot(CATALOG_TOML);
    const { body } = await postJson<unknown>('/api/v1/models/turbo:set_default', {});
    expect(body.code).toBe(0);
    // The engine's ModelAlias carries no displayName/maxContextSize, so the
    // echo uses the alias id and the fixed 1M window.
    expect(body.data).toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'kimi-turbo',
        display_name: 'turbo',
        max_context_size: 1_000_000,
      },
    });
  });

  it('maps unknown provider and model ids to catalog not-found codes', async () => {
    await boot(CATALOG_TOML);
    const provider = await getJson<unknown>('/api/v1/providers/missing');
    expect(provider.body.code).toBe(40412);

    const model = await postJson<unknown>('/api/v1/models/missing:set_default', {});
    expect(model.body.code).toBe(40413);
  });

  it('rejects unsupported provider actions with 40001', async () => {
    await boot(CATALOG_TOML);

    const { body } = await postJson('/api/v1/providers/foo:bogus', {});
    expect(body.code).toBe(40001);
  });
});
