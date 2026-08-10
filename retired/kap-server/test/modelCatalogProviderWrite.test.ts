/**
 * Engine-mode `/api/v1/providers` write endpoints — POST / PUT / DELETE.
 *
 * Engine-only semantics: writes go through the engine's `config/set` (deep
 * merge, camelCase KimiConfig on disk). The engine's `ModelAlias` carries
 * only `provider`/`model`/`max_tokens`, so persisted model aliases drop
 * `max_context_size`/`display_name`/`capabilities`; provider responses carry
 * no `models` array; provider rename (`new_id`) is rejected with 40001.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: Array<{ path: string; message: string }>;
}

const MANAGED_TOML = [
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'apiKey = ""',
  'baseUrl = "https://api.example.test/v1"',
  'oauth = { storage = "file", key = "oauth/kimi-code" }',
  '',
  '[models."managed:kimi-code/kimi-k2"]',
  'provider = "managed:kimi-code"',
  'model = "kimi-k2"',
  '',
].join('\n');

const CREATE_BODY = {
  id: 'my-openai',
  type: 'openai',
  api_key: 'sk-test-openai',
  base_url: 'https://api.openai.example/v1',
  default_model: 'gpt-4.1',
  models: [
    { model: 'gpt-4.1', max_context_size: 1047576, display_name: 'GPT-4.1' },
    { model: 'gpt-4o-mini', max_context_size: 128000 },
  ],
} as const;

describe('engine-mode /api/v1 provider write endpoints', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  // The Rust engine process is a module-level singleton: `KIMI_CONFIG_PATH`
  // freezes at the first spawn, so all cases share one home dir and `boot`
  // rewrites the same config file (the engine re-reads it per RPC).
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-engine-provider-write-'));
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

  async function deleteProvider(
    path: string,
  ): Promise<{ status: number; body: Envelope<unknown> | undefined }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    const text = await res.text();
    return { status: res.status, body: text.length === 0 ? undefined : JSON.parse(text) };
  }

  async function readConfigToml(): Promise<Record<string, unknown>> {
    const text = await readFile(join(home as string, 'config.toml'), 'utf-8');
    return parseToml(text) as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // POST /providers
  // -------------------------------------------------------------------------

  it('creates a provider and persists camelCase config.toml entries', async () => {
    await boot();
    const { status, body } = await postJson<Record<string, unknown>>('/api/v1/providers', CREATE_BODY);
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    // Engine projection: no `models` array; `default_model` echoes the
    // provider-scoped id.
    expect(body.data).toEqual({
      id: 'my-openai',
      type: 'openai',
      base_url: 'https://api.openai.example/v1',
      default_model: 'my-openai/gpt-4.1',
      has_api_key: true,
      status: 'connected',
    });

    const onDisk = await readConfigToml();
    const providers = onDisk['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['my-openai']).toEqual({
      type: 'openai',
      apiKey: 'sk-test-openai',
      baseUrl: 'https://api.openai.example/v1',
      defaultModel: 'my-openai/gpt-4.1',
    });
    // The engine's ModelAlias is {provider, model, max_tokens} — the form's
    // max_context_size/display_name are dropped by the engine config model.
    const models = onDisk['models'] as Record<string, Record<string, unknown>>;
    expect(models['my-openai/gpt-4.1']).toEqual({
      provider: 'my-openai',
      model: 'gpt-4.1',
    });
    expect(models['my-openai/gpt-4o-mini']).toEqual({
      provider: 'my-openai',
      model: 'gpt-4o-mini',
    });
    // Fresh setup: no global defaultModel → seeded from the provider default.
    expect(onDisk['defaultModel']).toBe('my-openai/gpt-4.1');
  });

  it('rejects a duplicate provider id with 40921', async () => {
    await boot();
    const first = await postJson<unknown>('/api/v1/providers', CREATE_BODY);
    expect(first.status).toBe(201);

    const dup = await postJson<null>('/api/v1/providers', CREATE_BODY);
    expect(dup.body.code).toBe(40921);
  });

  it('accepts a Unicode provider id (Chinese + space)', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/v1/providers', {
      ...CREATE_BODY,
      id: '我的 提供方',
    });
    expect(status).toBe(201);
  });

  it('rejects invalid create bodies with 40001', async () => {
    await boot();
    // default_model must name one of models[].model
    const dangling = await postJson<null>('/api/v1/providers', {
      ...CREATE_BODY,
      default_model: 'nope',
    });
    expect(dangling.body.code).toBe(40001);

    // duplicate model rows are rejected
    const dupRows = await postJson<null>('/api/v1/providers', {
      ...CREATE_BODY,
      models: [
        { model: 'gpt-4.1', max_context_size: 1000 },
        { model: 'gpt-4.1', max_context_size: 2000 },
      ],
    });
    expect(dupRows.body.code).toBe(40001);

    // empty model list
    const noModels = await postJson<null>('/api/v1/providers', { ...CREATE_BODY, models: [] });
    expect(noModels.body.code).toBe(40001);
  });

  // -------------------------------------------------------------------------
  // DELETE /providers/{id}
  // -------------------------------------------------------------------------

  it('deletes a provider and its model aliases (204)', async () => {
    await boot();
    await postJson<unknown>('/api/v1/providers', CREATE_BODY);

    const del = await deleteProvider('/api/v1/providers/my-openai');
    expect(del.status).toBe(204);
    expect(del.body).toBeUndefined();

    const onDisk = await readConfigToml();
    expect((onDisk['providers'] as Record<string, unknown>)['my-openai']).toBeUndefined();
    expect((onDisk['models'] as Record<string, unknown>)['my-openai/gpt-4.1']).toBeUndefined();
  });

  it('rejects deleting an OAuth-managed provider with 40003', async () => {
    await boot(MANAGED_TOML);
    const del = await deleteProvider('/api/v1/providers/managed:kimi-code');
    expect(del.body?.code).toBe(40003);
  });

  it('maps an unknown provider id to 40412 on delete', async () => {
    await boot();
    const del = await deleteProvider('/api/v1/providers/missing');
    expect(del.body?.code).toBe(40412);
  });

  // -------------------------------------------------------------------------
  // PUT /providers/{id}
  // -------------------------------------------------------------------------

  it('replaces a provider keeping the stored api_key (deep merge)', async () => {
    await boot();
    await postJson<unknown>('/api/v1/providers', CREATE_BODY);

    // api_key deliberately absent → kept.
    const replace = await putJson<Record<string, unknown>>('/api/v1/providers/my-openai', {
      type: 'openai',
      base_url: 'https://api.openai.example/v1',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(replace.body.code).toBe(0);
    expect(replace.body.data).toMatchObject({ id: 'my-openai', has_api_key: true });

    const onDisk = await readConfigToml();
    const providers = onDisk['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['my-openai']).toMatchObject({
      apiKey: 'sk-test-openai',
    });
    // The dropped alias is rebuilt away; the kept alias persists.
    const models = onDisk['models'] as Record<string, Record<string, unknown>>;
    expect(models['my-openai/gpt-4.1']).toEqual({ provider: 'my-openai', model: 'gpt-4.1' });
    expect(models['my-openai/gpt-4o-mini']).toBeUndefined();
  });

  it('sets a new api_key when a non-empty one is sent', async () => {
    await boot();
    await postJson<unknown>('/api/v1/providers', CREATE_BODY);

    const replace = await putJson<Record<string, unknown>>('/api/v1/providers/my-openai', {
      type: 'openai',
      api_key: 'sk-new',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(replace.body.code).toBe(0);

    const onDisk = await readConfigToml();
    const providers = onDisk['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['my-openai']).toMatchObject({ apiKey: 'sk-new' });
  });

  it('clears the stored api_key when an empty string is sent', async () => {
    await boot();
    await postJson<unknown>('/api/v1/providers', CREATE_BODY);

    const replace = await putJson<Record<string, unknown>>('/api/v1/providers/my-openai', {
      type: 'openai',
      api_key: '',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(replace.body.code).toBe(0);

    const onDisk = await readConfigToml();
    const providers = onDisk['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['my-openai']).toMatchObject({ apiKey: '' });

    // The single GET never reveals an empty-string key.
    const single = await getJson<Record<string, unknown>>('/api/v1/providers/my-openai');
    expect(single.body.code).toBe(0);
    expect(single.body.data).not.toHaveProperty('api_key');
  });

  it('rejects a rename (new_id) with 40001 — not supported on the native engine', async () => {
    await boot();
    await postJson<unknown>('/api/v1/providers', CREATE_BODY);

    const rename = await putJson<null>('/api/v1/providers/my-openai', {
      type: 'openai',
      new_id: 'renamed',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(rename.body.code).toBe(40001);
    expect(rename.body.msg).toMatch(/new_id/);
  });

  it('rejects invalid replace bodies with 40001', async () => {
    await boot();
    await postJson<unknown>('/api/v1/providers', CREATE_BODY);

    const noType = await putJson<null>('/api/v1/providers/my-openai', {
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(noType.body.code).toBe(40001);

    const noModels = await putJson<null>('/api/v1/providers/my-openai', { type: 'openai' });
    expect(noModels.body.code).toBe(40001);
  });

  it('rejects replacing an OAuth-managed provider with 40003', async () => {
    await boot(MANAGED_TOML);
    const replace = await putJson<null>('/api/v1/providers/managed:kimi-code', {
      type: 'kimi',
      models: [{ model: 'kimi-k2', max_context_size: 131072 }],
    });
    expect(replace.body.code).toBe(40003);
  });

  it('maps an unknown provider id to 40412 on replace', async () => {
    await boot();
    const replace = await putJson<null>('/api/v1/providers/missing', {
      type: 'openai',
      models: [{ model: 'gpt-4.1', max_context_size: 1047576 }],
    });
    expect(replace.body.code).toBe(40412);
  });

  it('trims a padded base_url before persisting', async () => {
    await boot();
    const { status } = await postJson<unknown>('/api/v1/providers', {
      ...CREATE_BODY,
      base_url: '  https://api.openai.example/v1  ',
    });
    expect(status).toBe(201);

    const onDisk = await readConfigToml();
    const providers = onDisk['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['my-openai']).toMatchObject({
      baseUrl: 'https://api.openai.example/v1',
    });
  });
});
