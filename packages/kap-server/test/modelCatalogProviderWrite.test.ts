import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: Array<{ path: string; message: string }>;
}

/** default_provider/default_model both point at the openai provider. */
const DEFAULTED_TOML = [
  'default_provider = "openai"',
  'default_model = "gpt4o"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  '',
  '[providers.openai]',
  'type = "openai"',
  'api_key = "sk-openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  'max_context_size = 128000',
  '',
].join('\n');

/** Same providers/models, but the global default model belongs to kimi. */
const KEEP_DEFAULT_TOML = DEFAULTED_TOML.replace('default_provider = "openai"\n', '').replace(
  'default_model = "gpt4o"',
  'default_model = "k2"',
);

/** A default_model pointing at an alias that does not exist. */
const DANGLING_DEFAULT_TOML = [
  'default_model = "gone"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  '',
].join('\n');

const MANAGED_TOML = [
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'api_key = ""',
  'base_url = "https://api.example.test/v1"',
  'oauth = { storage = "file", key = "oauth/kimi-code" }',
  '',
  '[models."managed:kimi-code/kimi-k2"]',
  'provider = "managed:kimi-code"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  '',
].join('\n');

const CREATE_BODY = {
  id: 'my-openai',
  type: 'openai',
  api_key: 'sk-test-openai',
  base_url: 'https://api.openai.example/v1',
  default_model: 'gpt-4.1',
  models: [
    {
      model: 'gpt-4.1',
      max_context_size: 1047576,
      display_name: 'GPT-4.1',
      capabilities: ['vision'],
      max_output_size: 32768,
    },
    { model: 'gpt-4o-mini', max_context_size: 128000 },
  ],
} as const;

/** Full "edit & save" form for the openai provider; api_key deliberately absent. */
const REPLACE_BODY = {
  type: 'openai',
  base_url: 'https://api.openai.example/v1',
  default_model: 'gpt-4.1',
  models: [
    { model: 'gpt-4.1', max_context_size: 1047576, display_name: 'GPT-4.1' },
    { model: 'gpt-4o-mini', max_context_size: 128000 },
  ],
} as const;

describe('server-v2 /api/v1 provider write endpoints', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-provider-write-'));
    // Disable the background refresh scheduler so it never rewrites config
    // underneath the write-path assertions below.
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    delete process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'];
    delete process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'];
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
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

  async function putJson<T>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function deleteJson<T>(
    path: string,
  ): Promise<{ status: number; text: string; body: Envelope<T> | undefined }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text.length === 0 ? undefined : (JSON.parse(text) as Envelope<T>),
    };
  }

  async function readConfigToml(): Promise<Record<string, unknown>> {
    const text = await readFile(join(home as string, 'config.toml'), 'utf-8');
    return parseToml(text) as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // POST /providers
  // -------------------------------------------------------------------------

  it('creates a provider with model aliases and persists them to config.toml', async () => {
    await boot();
    const { status, body } = await postJson<unknown>('/api/v1/providers', CREATE_BODY);
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      id: 'my-openai',
      type: 'openai',
      base_url: 'https://api.openai.example/v1',
      default_model: 'my-openai/gpt-4.1',
      has_api_key: true,
      status: 'connected',
      models: ['my-openai/gpt-4.1', 'my-openai/gpt-4o-mini'],
    });

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      'my-openai': {
        type: 'openai',
        api_key: 'sk-test-openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'my-openai/gpt-4.1',
      },
    });
    expect(onDisk['models']).toEqual({
      'my-openai/gpt-4.1': {
        provider: 'my-openai',
        model: 'gpt-4.1',
        max_context_size: 1047576,
        display_name: 'GPT-4.1',
        capabilities: ['vision'],
        max_output_size: 32768,
      },
      'my-openai/gpt-4o-mini': {
        provider: 'my-openai',
        model: 'gpt-4o-mini',
        max_context_size: 128000,
      },
    });

    const providers = await getJson<{ items: unknown[] }>('/api/v1/providers');
    expect(providers.body.data.items).toEqual([body.data]);

    const models = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(models.body.data.items).toEqual([
      {
        provider: 'my-openai',
        model: 'my-openai/gpt-4.1',
        display_name: 'GPT-4.1',
        max_context_size: 1047576,
        capabilities: ['vision'],
      },
      {
        provider: 'my-openai',
        model: 'my-openai/gpt-4o-mini',
        display_name: 'gpt-4o-mini',
        max_context_size: 128000,
      },
    ]);
  });

  it('creates a credential-less provider (env-resolved types may omit api_key)', async () => {
    await boot();
    const { status, body } = await postJson<unknown>('/api/v1/providers', {
      id: 'vertex',
      type: 'vertexai',
      models: [{ model: 'gemini-2.5-pro', max_context_size: 1048576 }],
    });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      id: 'vertex',
      type: 'vertexai',
      // No provider-level default, but the fresh-setup seeding made this
      // model the global default — and the projection falls back to it.
      default_model: 'vertex/gemini-2.5-pro',
      has_api_key: false,
      status: 'unconfigured',
      models: ['vertex/gemini-2.5-pro'],
    });
  });

  it('seeds the global default_model on a fresh setup (the provider default wins)', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/v1/providers', CREATE_BODY);
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('my-openai/gpt-4.1');

    // End-to-end: the readiness probe now reports a usable daemon.
    const auth = await getJson<{ ready: boolean; default_model: string | null }>('/api/v1/auth');
    expect(auth.body.data).toMatchObject({ ready: true, default_model: 'my-openai/gpt-4.1' });
  });

  it('seeds the first model when the create body names no provider default', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/v1/providers', {
      id: 'my-openai',
      type: 'openai',
      api_key: 'sk-test-openai',
      models: [
        { model: 'gpt-4o-mini', max_context_size: 128000 },
        { model: 'gpt-4.1', max_context_size: 1047576 },
      ],
    });
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('my-openai/gpt-4o-mini');
  });

  it('keeps an existing global default_model on create', async () => {
    await boot(DEFAULTED_TOML);
    const { status } = await postJson<unknown>('/api/v1/providers', CREATE_BODY);
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('gpt4o');
  });

  it('leaves even a dangling default_model untouched on create', async () => {
    await boot(DANGLING_DEFAULT_TOML);
    const { status } = await postJson<unknown>('/api/v1/providers', CREATE_BODY);
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['default_model']).toBe('gone');
  });

  it('rejects a duplicate provider id with 40921', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await postJson<unknown>('/api/v1/providers', {
      ...CREATE_BODY,
      id: 'openai',
    });
    expect(body.code).toBe(40921);
    expect(body.data).toBeNull();

    // The existing provider is left untouched.
    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/v1/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['kimi', 'openai']);
  });

  it('accepts a Unicode provider id (Chinese + space)', async () => {
    await boot();
    const { status, body } = await postJson<{ id: string }>('/api/v1/providers', {
      ...CREATE_BODY,
      id: '测试 Kimi',
    });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data.id).toBe('测试 Kimi');

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toMatchObject({ '测试 Kimi': { type: 'openai' } });
    expect(onDisk['models']).toMatchObject({
      '测试 Kimi/gpt-4.1': { provider: '测试 Kimi', model: 'gpt-4.1' },
    });
  });

  it('creates models with support_efforts and adaptive_thinking', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/v1/providers', {
      ...CREATE_BODY,
      models: [
        {
          model: 'gpt-4.1',
          max_context_size: 1047576,
          support_efforts: ['low', 'max'],
          adaptive_thinking: true,
        },
      ],
    });
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    expect(onDisk['models']).toMatchObject({
      'my-openai/gpt-4.1': {
        support_efforts: ['low', 'max'],
        adaptive_thinking: true,
      },
    });
  });

  it('rejects invalid create bodies with 40001', async () => {
    await boot();
    const cases: Array<{ name: string; body: unknown; path?: string }> = [
      {
        name: 'id with illegal characters',
        body: { ...CREATE_BODY, id: 'bad!id' },
        path: 'id',
      },
      { name: 'unknown wire type', body: { ...CREATE_BODY, type: 'custom' }, path: 'type' },
      { name: 'empty models list', body: { ...CREATE_BODY, models: [] }, path: 'models' },
      {
        name: 'default_model outside the models list',
        body: { ...CREATE_BODY, default_model: 'gpt-5' },
        path: 'default_model',
      },
    ];
    for (const { name, body, path } of cases) {
      const { body: envelope } = await postJson('/api/v1/providers', body);
      expect(envelope.code, name).toBe(40001);
      expect(envelope.data, name).toBeNull();
      if (path !== undefined) {
        expect(
          envelope.details?.some((detail) => detail.path === path),
          name,
        ).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /providers/{provider_id}
  // -------------------------------------------------------------------------

  it('deletes a provider and its model aliases, keeping unrelated defaults', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, text } = await deleteJson<unknown>('/api/v1/providers/openai');
    expect(status).toBe(204);
    expect(text).toBe('');

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({ kimi: { type: 'kimi', api_key: 'sk-test' } });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
    });
    expect(onDisk['default_model']).toBe('k2');

    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/v1/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['kimi']);
    const models = await getJson<{ items: Array<{ model: string }> }>('/api/v1/models');
    expect(models.body.data.items.map((m) => m.model)).toEqual(['k2']);
  });

  it('never touches default_provider/default_model when deleting their owner (204, pointers dangling)', async () => {
    await boot(DEFAULTED_TOML);
    const { status, text } = await deleteJson<unknown>('/api/v1/providers/openai');
    expect(status).toBe(204);
    expect(text).toBe('');

    const onDisk = await readConfigToml();
    // The pointers are the user's settings: they stay put even though the
    // provider/aliases they reference are gone.
    expect(onDisk['default_provider']).toBe('openai');
    expect(onDisk['default_model']).toBe('gpt4o');
    expect(onDisk['providers']).toEqual({ kimi: { type: 'kimi', api_key: 'sk-test' } });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
    });
  });

  it('round-trips a created provider: delete removes every trace from config.toml', async () => {
    await boot();
    const created = await postJson<unknown>('/api/v1/providers', CREATE_BODY);
    expect(created.status).toBe(201);

    const { status } = await deleteJson<unknown>('/api/v1/providers/my-openai');
    expect(status).toBe(204);

    const onDisk = await readConfigToml();
    // The last provider/model drops the whole TOML table, not an empty stub.
    expect(onDisk['providers']).toBeUndefined();
    expect(onDisk['models']).toBeUndefined();
    // Except the seeded global default: pointers are the user's settings and
    // deletes never garbage-collect them (it dangles until re-pointed).
    expect(onDisk['default_model']).toBe('my-openai/gpt-4.1');

    const providers = await getJson<{ items: unknown[] }>('/api/v1/providers');
    expect(providers.body.data.items).toEqual([]);
  });

  it('rejects deleting an OAuth-managed provider with 40003', async () => {
    await boot(MANAGED_TOML);
    const { body } = await deleteJson<unknown>('/api/v1/providers/managed%3Akimi-code');
    expect(body?.code).toBe(40003);
    expect(body?.msg).toContain('/oauth/logout');

    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/v1/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['managed:kimi-code']);
  });

  it('maps an unknown provider id to 40412 on delete', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await deleteJson<unknown>('/api/v1/providers/missing');
    expect(body?.code).toBe(40412);
  });

  // -------------------------------------------------------------------------
  // PUT /providers/{provider_id}
  // -------------------------------------------------------------------------

  it('replaces a provider, keeping the stored api_key and rebuilding its aliases', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await putJson<{
      provider: Record<string, unknown>;
    }>('/api/v1/providers/openai', REPLACE_BODY);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.provider).toEqual({
      id: 'openai',
      type: 'openai',
      base_url: 'https://api.openai.example/v1',
      default_model: 'openai/gpt-4.1',
      has_api_key: true,
      status: 'connected',
      models: ['openai/gpt-4.1', 'openai/gpt-4o-mini'],
    });

    const onDisk = await readConfigToml();
    // The removed alias (`gpt4o`) is really gone from config.toml; the other
    // provider's alias (`k2`) and its global default pointer are untouched.
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: {
        type: 'openai',
        api_key: 'sk-openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'openai/gpt-4.1',
      },
    });
    expect(onDisk['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
      'openai/gpt-4.1': {
        provider: 'openai',
        model: 'gpt-4.1',
        max_context_size: 1047576,
        display_name: 'GPT-4.1',
      },
      'openai/gpt-4o-mini': {
        provider: 'openai',
        model: 'gpt-4o-mini',
        max_context_size: 128000,
      },
    });
    expect(onDisk['default_model']).toBe('k2');

    const models = await getJson<{ items: Array<{ model: string }> }>('/api/v1/models');
    expect(models.body.data.items.map((m) => m.model)).toEqual([
      'k2',
      'openai/gpt-4.1',
      'openai/gpt-4o-mini',
    ]);
  });

  it('sets a new api_key when a non-empty one is sent', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await putJson<{ provider: { has_api_key: boolean } }>(
      '/api/v1/providers/openai',
      { ...REPLACE_BODY, api_key: 'sk-new-openai' },
    );
    expect(status).toBe(200);
    expect(body.data.provider.has_api_key).toBe(true);

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: {
        type: 'openai',
        api_key: 'sk-new-openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'openai/gpt-4.1',
      },
    });
  });

  it('clears the stored api_key when an empty string is sent', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await putJson<{
      provider: { has_api_key: boolean; status: string };
    }>('/api/v1/providers/openai', { ...REPLACE_BODY, api_key: '' });
    expect(status).toBe(200);
    expect(body.data.provider.has_api_key).toBe(false);
    expect(body.data.provider.status).toBe('unconfigured');

    // Cleared persists as `api_key = ""` — the same form authService writes
    // for keyless providers; runtime credential resolution treats it as no key.
    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: {
        type: 'openai',
        api_key: '',
        base_url: 'https://api.openai.example/v1',
        default_model: 'openai/gpt-4.1',
      },
    });
  });

  it('merges onto existing model records: unknown fields preserved, form fields authoritative', async () => {
    const RICH_TOML = [
      '[providers.openai]',
      'type = "openai"',
      'api_key = "sk-openai"',
      '',
      '[models."openai/gpt-4o"]',
      'provider = "openai"',
      'model = "gpt-4o"',
      'max_context_size = 128000',
      'beta_api = true',
      'default_effort = "high"',
      '',
    ].join('\n');
    await boot(RICH_TOML);
    const { status, body } = await putJson<unknown>('/api/v1/providers/openai', {
      type: 'openai',
      models: [
        {
          model: 'gpt-4o',
          max_context_size: 256000,
          capabilities: ['thinking', 'tool_use'],
          support_efforts: ['low', 'high', 'max'],
          adaptive_thinking: true,
        },
      ],
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const onDisk = await readConfigToml();
    expect(onDisk['models']).toEqual({
      'openai/gpt-4o': {
        provider: 'openai',
        model: 'gpt-4o',
        max_context_size: 256000,
        // Unknown to the form — preserved:
        beta_api: true,
        default_effort: 'high',
        // Form-authoritative:
        capabilities: ['thinking', 'tool_use'],
        support_efforts: ['low', 'high', 'max'],
        adaptive_thinking: true,
      },
    });
  });

  it('never touches default_model when the rebuild drops its alias (no rename)', async () => {
    await boot(DEFAULTED_TOML);
    const { status, body } = await putJson<unknown>(
      '/api/v1/providers/openai',
      { ...REPLACE_BODY, type: 'openai_responses' },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const onDisk = await readConfigToml();
    // `gpt4o` is gone from the models section, yet the global default pointer
    // stays — it is the user's setting, not this endpoint's to clear.
    expect(onDisk['default_model']).toBe('gpt4o');
    expect(onDisk['default_provider']).toBe('openai');
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: {
        type: 'openai_responses',
        api_key: 'sk-openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'openai/gpt-4.1',
      },
    });
  });

  it('renames a provider: providers key, aliases, default_provider and default_model all migrate', async () => {
    await boot(DEFAULTED_TOML);
    const { status, body } = await putJson<{
      provider: Record<string, unknown>;
    }>('/api/v1/providers/openai', {
      ...REPLACE_BODY,
      new_id: 'my-openai',
      models: [
        { model: 'gpt-4o', max_context_size: 128000 },
        { model: 'gpt-4.1', max_context_size: 1047576 },
      ],
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.provider['id']).toBe('my-openai');

    const onDisk2 = await readConfigToml();
    expect(onDisk2['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      'my-openai': {
        type: 'openai',
        api_key: 'sk-openai',
        base_url: 'https://api.openai.example/v1',
        default_model: 'my-openai/gpt-4.1',
      },
    });
    expect(onDisk2['models']).toEqual({
      k2: { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
      'my-openai/gpt-4o': { provider: 'my-openai', model: 'gpt-4o', max_context_size: 128000 },
      'my-openai/gpt-4.1': { provider: 'my-openai', model: 'gpt-4.1', max_context_size: 1047576 },
    });
    expect(onDisk2['default_provider']).toBe('my-openai');
    // The old default alias (`gpt4o`, record model gpt-4o) is repointed at the
    // rebuilt alias under the new prefix.
    expect(onDisk2['default_model']).toBe('my-openai/gpt-4o');
  });

  it('migrates default_provider on rename but leaves default_model alone when its model was dropped', async () => {
    await boot(DEFAULTED_TOML);
    const { status, body } = await putJson<unknown>(
      '/api/v1/providers/openai',
      { ...REPLACE_BODY, new_id: 'my-openai' },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const onDisk = await readConfigToml();
    expect(onDisk['default_provider']).toBe('my-openai');
    // The dropped model's alias can no longer be repointed — and the pointer
    // is still left dangling rather than cleared.
    expect(onDisk['default_model']).toBe('gpt4o');
  });

  it('rejects a rename to an existing provider id with 40921', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await putJson<unknown>('/api/v1/providers/openai', {
      ...REPLACE_BODY,
      new_id: 'kimi',
    });
    expect(status).toBe(200);
    expect(body.code).toBe(40921);

    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      kimi: { type: 'kimi', api_key: 'sk-test' },
      openai: { type: 'openai', api_key: 'sk-openai' },
    });
  });

  it('rejects invalid replace bodies with 40001', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const cases: Array<{ name: string; body: unknown; path?: string }> = [
      { name: 'unknown wire type', body: { ...REPLACE_BODY, type: 'custom' }, path: 'type' },
      { name: 'empty models list', body: { ...REPLACE_BODY, models: [] }, path: 'models' },
      {
        name: 'default_model outside the models list',
        body: { ...REPLACE_BODY, default_model: 'gpt-5' },
        path: 'default_model',
      },
    ];
    for (const { name, body, path } of cases) {
      const { body: envelope } = await putJson('/api/v1/providers/openai', body);
      expect(envelope.code, name).toBe(40001);
      expect(envelope.data, name).toBeNull();
      if (path !== undefined) {
        expect(
          envelope.details?.some((detail) => detail.path === path),
          name,
        ).toBe(true);
      }
    }
  });

  it('rejects replacing an OAuth-managed provider with 40003', async () => {
    await boot(MANAGED_TOML);
    const { body } = await putJson<unknown>(
      '/api/v1/providers/managed%3Akimi-code',
      REPLACE_BODY,
    );
    expect(body.code).toBe(40003);
    expect(body.msg).toContain('/oauth/logout');

    // The managed provider and its alias are left untouched.
    const providers = await getJson<{ items: Array<{ id: string }> }>('/api/v1/providers');
    expect(providers.body.data.items.map((p) => p.id)).toEqual(['managed:kimi-code']);
    const models = await getJson<{ items: Array<{ model: string }> }>('/api/v1/models');
    expect(models.body.data.items.map((m) => m.model)).toEqual(['managed:kimi-code/kimi-k2']);
  });

  it('maps an unknown provider id to 40412 on replace', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await putJson<unknown>('/api/v1/providers/missing', REPLACE_BODY);
    expect(body.code).toBe(40412);
    expect(body.data).toBeNull();
  });

  // Field-level clears must reach the disk: the TOML transform overlays each
  // kept entry onto its old on-disk raw, so a field absent from the body
  // would silently survive (and resurrect on the next boot) unless the route
  // assigns an explicit undefined. These cases lock the disk state, not just
  // the in-memory view.
  it('clears omitted provider fields (base_url/default_model) from config.toml for real', async () => {
    const FULL_TOML = [
      '[providers.openai]',
      'type = "openai"',
      'api_key = "sk-openai"',
      'base_url = "https://api.openai.example/v1"',
      'default_model = "openai/gpt-4.1"',
      'custom_headers = { "X-Org" = "acme" }',
      '',
      '[models."openai/gpt-4.1"]',
      'provider = "openai"',
      'model = "gpt-4.1"',
      'max_context_size = 1047576',
      'display_name = "GPT-4.1"',
      'capabilities = ["tool_use"]',
      '',
    ].join('\n');
    await boot(FULL_TOML);
    const { status } = await putJson<unknown>('/api/v1/providers/openai', {
      type: 'openai',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(status).toBe(200);

    const onDisk = await readConfigToml();
    // base_url/default_model are gone from the DISK too — while the
    // form-unknown custom_headers rides along.
    expect(onDisk['providers']).toEqual({
      openai: {
        type: 'openai',
        api_key: 'sk-openai',
        custom_headers: { 'X-Org': 'acme' },
      },
    });
    // Alias-level form fields are cleared the same way.
    expect(onDisk['models']).toEqual({
      'openai/gpt-4.1': {
        provider: 'openai',
        model: 'gpt-4.1',
        max_context_size: 1047576,
      },
    });

    // The in-memory projection agrees (no base_url/default_model either).
    const single = await getJson<Record<string, unknown>>('/api/v1/providers/openai');
    expect(single.body.data).not.toHaveProperty('base_url');
    expect(single.body.data).not.toHaveProperty('default_model');
  });

  it('does not reveal an empty-string api_key on the single GET', async () => {
    await boot(KEEP_DEFAULT_TOML);
    // Clear the key first (persists as api_key = "")…
    await putJson<unknown>('/api/v1/providers/openai', { ...REPLACE_BODY, api_key: '' });
    // …then the single GET must not surface the empty sentinel as a real key.
    const { body } = await getJson<Record<string, unknown>>('/api/v1/providers/openai');
    expect(body.data).not.toHaveProperty('api_key');
  });

  it('rejects duplicate model rows with 40001 on both create and replace', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const duplicate = {
      ...CREATE_BODY,
      models: [
        { model: 'gpt-4.1', max_context_size: 1047576 },
        { model: 'gpt-4.1', max_context_size: 128000 },
      ],
    };
    const created = await postJson<unknown>('/api/v1/providers', duplicate);
    expect(created.body.code).toBe(40001);
    expect(created.body.msg).toContain('duplicate model');

    const replaced = await putJson<unknown>('/api/v1/providers/openai', {
      type: 'openai',
      models: [
        { model: 'gpt-4.1', max_context_size: 1047576 },
        { model: 'gpt-4.1', max_context_size: 128000 },
      ],
    });
    expect(replaced.body.code).toBe(40001);
  });

  it('rejects a base_url containing an env placeholder with 40001', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { body } = await postJson<unknown>('/api/v1/providers', {
      ...CREATE_BODY,
      base_url: 'https://${HOST}/v1',
    });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('base_url');
  });

  it('trims a padded base_url before persisting', async () => {
    await boot(KEEP_DEFAULT_TOML);
    const { status, body } = await postJson<{ base_url?: string }>('/api/v1/providers', {
      ...CREATE_BODY,
      base_url: '  https://api.openai.example/v1  ',
    });
    expect(status).toBe(201);
    expect(body.data.base_url).toBe('https://api.openai.example/v1');
  });

  it('rejects a rename/rebuild whose alias key is owned by another provider (40001, no writes)', async () => {
    // A foreign-prefix alias: the key says openai/… but the record belongs to
    // "other" (hand-edited config or a historical leftover).
    const FOREIGN_TOML = [
      '[providers.openai]',
      'type = "openai"',
      'api_key = "sk-openai"',
      '',
      '[providers.other]',
      'type = ' + '"anthropic"',
      'api_key = "sk-other"',
      '',
      '[models."openai/gpt-4.1"]',
      'provider = "other"',
      'model = "claude-thing"',
      'max_context_size = 200000',
      '',
      '[models."other/claude-thing"]',
      'provider = "other"',
      'model = "claude-thing"',
      'max_context_size = 200000',
      '',
    ].join('\n');
    await boot(FOREIGN_TOML);
    const { status, body } = await putJson<unknown>('/api/v1/providers/openai', {
      type: 'openai',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(status).toBe(200);
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('openai/gpt-4.1');

    // No partial write: both providers and the foreign alias are untouched.
    const onDisk = await readConfigToml();
    expect(onDisk['providers']).toEqual({
      openai: { type: 'openai', api_key: 'sk-openai' },
      other: { type: 'anthropic', api_key: 'sk-other' },
    });
    const models = onDisk['models'] as Record<string, Record<string, unknown>>;
    expect(models['openai/gpt-4.1']).toEqual({
      provider: 'other',
      model: 'claude-thing',
      max_context_size: 200000,
    });
  });
});
