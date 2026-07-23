import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetCatalogUpstreamForTest, setCatalogUpstreamForTest } from '../src/catalogUpstream';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

/**
 * A pruned models.dev-shaped fixture: one clean OpenAI entry, one proprietary
 * SDK entry (rejected), one gateway entry whose endpoint cannot be resolved
 * without a user base URL, and one entry with no usable models.
 */
const CATALOG = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    api: 'https://api.openai.com/v1',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-4.1': {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        limit: { context: 1047576, input: 1047576, output: 32768 },
        tool_call: true,
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        limit: { context: 128000 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  bedrock: {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    api: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    npm: '@ai-sdk/amazon-bedrock',
    models: {
      'claude-sonnet': {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        limit: { context: 200000 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  gateway: {
    id: 'gateway',
    name: 'Some Gateway',
    npm: 'some-gateway-sdk',
    models: {
      'gw-model': {
        id: 'gw-model',
        limit: { context: 64000 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  'empty-models': {
    id: 'empty-models',
    name: 'Empty',
    api: 'https://empty.example/v1',
    npm: '@ai-sdk/openai',
    models: {},
  },
} as const;

const MANAGED_OPENAI_TOML = [
  '[providers.openai]',
  'type = "openai"',
  'api_key = "sk-managed"',
  'oauth = { storage = "file", key = "oauth/openai" }',
  '',
].join('\n');

const DEFAULTED_TOML = [
  'default_provider = "kimi"',
  'default_model = "k2"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  '',
].join('\n');

function catalogFetchOk(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(CATALOG), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function catalogFetchFail(): typeof fetch {
  return (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

describe('server-v2 /api/v1 catalog browse + import endpoints', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-catalog-'));
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'] = '0';
    process.env['KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'] = '0';
    resetCatalogUpstreamForTest();
    setCatalogUpstreamForTest({ fetchImpl: catalogFetchOk() });
  });

  afterEach(async () => {
    resetCatalogUpstreamForTest();
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

  async function readConfigToml(): Promise<Record<string, unknown>> {
    const text = await readFile(join(home as string, 'config.toml'), 'utf-8');
    return parseToml(text) as Record<string, unknown>;
  }

  /**
   * Poll a server-side (in-memory) condition: hand edits to config.toml only
   * take effect after the file watcher reloads, and a write that starts from
   * the pre-edit state would silently drop them.
   */
  async function waitForServerState(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('waitForServerState timed out');
  }

  // -------------------------------------------------------------------------
  // GET /catalog/providers
  // -------------------------------------------------------------------------

  it('lists pruned directory entries with import eligibility resolved', async () => {
    await boot();
    const { status, body } = await getJson<{ items: Array<Record<string, unknown>> }>(
      '/api/v1/catalog/providers',
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    const byId = new Map(body.data.items.map((item) => [item['id'], item]));

    const openai = byId.get('openai') as Record<string, unknown>;
    expect(openai['name']).toBe('OpenAI');
    expect(openai['wire_type']).toBe('openai');
    expect(openai['needs_base_url']).toBe(false);
    expect(openai['rejected']).toBe(false);
    expect(openai['reject_reason']).toBeNull();
    expect(openai['env_key']).toBe('OPENAI_API_KEY');
    const models = openai['models'] as Array<Record<string, unknown>>;
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      max_context_size: 1047576,
      reasoning: false,
    });
    expect(models[0]?.['capabilities']).toEqual(['image_in', 'tool_use']);

    const bedrock = byId.get('bedrock') as Record<string, unknown>;
    expect(bedrock['rejected']).toBe(true);
    expect(bedrock['reject_reason']).toBe('proprietary-sdk');
    expect(bedrock['wire_type']).toBeNull();

    const gateway = byId.get('gateway') as Record<string, unknown>;
    expect(gateway['rejected']).toBe(false);
    expect(gateway['needs_base_url']).toBe(true);
    expect(gateway['wire_type']).toBe('openai');
  });

  it('serves the second request from the in-memory cache', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }) as unknown as typeof fetch;
    setCatalogUpstreamForTest({ fetchImpl: counting });

    await boot();
    const first = await getJson('/api/v1/catalog/providers');
    const second = await getJson('/api/v1/catalog/providers');
    expect(first.body.code).toBe(0);
    expect(second.body.code).toBe(0);
    expect(calls).toBe(1);
  });

  it('falls back to the stale cache when a refetch fails', async () => {
    const t0 = 1_000_000;
    let now = t0;
    setCatalogUpstreamForTest({ now: () => now });

    await boot();
    const first = await getJson<{ items: unknown[] }>('/api/v1/catalog/providers');
    expect(first.body.code).toBe(0);

    // Past the 10-minute TTL, with the network now down: stale cache serves.
    now = t0 + 11 * 60 * 1000;
    setCatalogUpstreamForTest({ fetchImpl: catalogFetchFail() });
    const second = await getJson<{ items: unknown[] }>('/api/v1/catalog/providers');
    expect(second.body.code).toBe(0);
    expect(second.body.data.items.length).toBe(first.body.data.items.length);
  });

  it('answers 50004 when the fetch fails and no cache or snapshot exists', async () => {
    setCatalogUpstreamForTest({ fetchImpl: catalogFetchFail() });
    await boot();
    const { status, body } = await getJson('/api/v1/catalog/providers');
    expect(status).toBe(200);
    expect(body.code).toBe(50004);
    expect(body.msg).toContain('unavailable');
  });

  // -------------------------------------------------------------------------
  // GET /catalog/providers/{catalog_id}
  // -------------------------------------------------------------------------

  it('gets a single directory entry by id', async () => {
    await boot();
    const { status, body } = await getJson<Record<string, unknown>>(
      '/api/v1/catalog/providers/openai',
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data['id']).toBe('openai');
    expect(body.data['wire_type']).toBe('openai');
  });

  it('answers 40417 for an unknown catalog id', async () => {
    await boot();
    const { body } = await getJson('/api/v1/catalog/providers/nope');
    expect(body.code).toBe(40417);
  });

  // -------------------------------------------------------------------------
  // POST /providers:import_catalog
  // -------------------------------------------------------------------------

  it('imports a catalog entry as a provider with all model aliases', async () => {
    await boot();
    const { status, body } = await postJson<{
      provider: Record<string, unknown>;
      models_imported: number;
    }>('/api/v1/providers:import_catalog', { catalog_id: 'openai', api_key: 'sk-imported' });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data.models_imported).toBe(2);
    expect(body.data.provider).toMatchObject({
      id: 'openai',
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      has_api_key: true,
    });

    const config = await readConfigToml();
    const providers = config['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['openai']).toMatchObject({
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-imported',
    });
    const models = config['models'] as Record<string, Record<string, unknown>>;
    expect(models['openai/gpt-4.1']).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      max_context_size: 1047576,
      max_input_size: 1047576,
      max_output_size: 32768,
      display_name: 'GPT-4.1',
    });
    expect(models['openai/gpt-4.1']?.['capabilities']).toEqual(['image_in', 'tool_use']);
    expect(models['openai/gpt-4o-mini']).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('never touches the global default pointers on import', async () => {
    await boot(DEFAULTED_TOML);
    const { status } = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-imported',
    });
    expect(status).toBe(201);
    const config = await readConfigToml();
    expect(config['default_provider']).toBe('kimi');
    expect(config['default_model']).toBe('k2');
  });

  it('re-imports an existing id as a refresh: credentials replaced, stale aliases dropped', async () => {
    await boot(DEFAULTED_TOML);
    const first = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-one',
    });
    expect(first.status).toBe(201);

    // Hand-add a stale alias that a refresh must remove.
    const before = await readConfigToml();
    const models = before['models'] as Record<string, unknown>;
    models['openai/retired'] = { provider: 'openai', model: 'retired', max_context_size: 1 };
    const { stringify: stringifyToml } = await import('smol-toml');
    await writeFile(join(home as string, 'config.toml'), stringifyToml(before), 'utf-8');
    // Wait for the file watcher to actually reload (the next write must start
    // from the edited state, or the edit is silently lost).
    await waitForServerState(async () => {
      const cfg = await getJson<{ models: Record<string, unknown> }>('/api/v1/config');
      return 'openai/retired' in (cfg.body.data.models ?? {});
    });

    const second = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-two',
    });
    expect(second.status).toBe(201);

    const after = await readConfigToml();
    const providers = after['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['openai']?.['api_key']).toBe('sk-two');
    const afterModels = after['models'] as Record<string, unknown>;
    expect(afterModels['openai/retired']).toBeUndefined();
    expect(afterModels['openai/gpt-4.1']).toBeDefined();
    expect(afterModels['k2']).toBeDefined();
  });

  it('keeps the stored api_key when a re-import omits it (tri-state like PUT)', async () => {
    await boot(DEFAULTED_TOML);
    const first = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-one',
    });
    expect(first.status).toBe(201);

    const second = await postJson<{ provider: { has_api_key: boolean } }>(
      '/api/v1/providers:import_catalog',
      { catalog_id: 'openai' },
    );
    expect(second.status).toBe(201);
    expect(second.body.data.provider.has_api_key).toBe(true);

    const after = await readConfigToml();
    const providers = after['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['openai']?.['api_key']).toBe('sk-one');
  });

  it('clears stale on-disk alias fields the upstream no longer lists (two-pass swap)', async () => {
    await boot(DEFAULTED_TOML);
    const first = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-one',
    });
    expect(first.status).toBe(201);

    // Hand-edit a kept alias with a field the catalog does not declare
    // (max_input_size here is real for gpt-4.1 — use a fake extra instead).
    const before = await readConfigToml();
    const models = before['models'] as Record<string, Record<string, unknown>>;
    models['openai/gpt-4o-mini'] = {
      ...(models['openai/gpt-4o-mini'] as Record<string, unknown>),
      beta_api: true,
      default_effort: 'high',
    };
    const { stringify: stringifyToml } = await import('smol-toml');
    await writeFile(join(home as string, 'config.toml'), stringifyToml(before), 'utf-8');
    await waitForServerState(async () => {
      const cfg = await getJson<{ models: Record<string, Record<string, unknown>> }>(
        '/api/v1/config',
      );
      return cfg.body.data.models['openai/gpt-4o-mini']?.['betaApi'] === true;
    });

    const second = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
    });
    expect(second.status).toBe(201);

    // Import = remove-then-apply: hand edits on a kept alias do NOT survive,
    // not even as raw on-disk residue.
    const after = await readConfigToml();
    const afterModels = after['models'] as Record<string, Record<string, unknown>>;
    expect(afterModels['openai/gpt-4o-mini']).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      max_context_size: 128000,
      capabilities: ['tool_use'],
      display_name: 'GPT-4o mini',
    });
  });

  it('answers 40417 for prototype-chain catalog ids (constructor/__proto__)', async () => {
    await boot();
    const first = await getJson('/api/v1/catalog/providers/constructor');
    expect(first.body.code).toBe(40417);
    const second = await getJson('/api/v1/catalog/providers/__proto__');
    expect(second.body.code).toBe(40417);
  });

  it('honors the id override for the local provider id', async () => {
    await boot();
    const { status, body } = await postJson<{ provider: Record<string, unknown> }>(
      '/api/v1/providers:import_catalog',
      { catalog_id: 'openai', api_key: 'sk-x', id: 'my-oai' },
    );
    expect(status).toBe(201);
    expect(body.data.provider['id']).toBe('my-oai');
    const config = await readConfigToml();
    const providers = config['providers'] as Record<string, unknown>;
    expect(providers['my-oai']).toBeDefined();
    expect(providers['openai']).toBeUndefined();
    const models = config['models'] as Record<string, unknown>;
    expect(models['my-oai/gpt-4.1']).toBeDefined();
  });

  it('answers 40004 for a rejected catalog entry', async () => {
    await boot();
    const { body } = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'bedrock',
      api_key: 'sk-x',
    });
    expect(body.code).toBe(40004);
    expect(body.msg).toContain('proprietary-sdk');
  });

  it('answers 40004 when a needs-base-url entry is imported without one, 201 with one', async () => {
    await boot();
    const missing = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'gateway',
      api_key: 'sk-x',
    });
    expect(missing.body.code).toBe(40004);
    expect(missing.body.msg).toContain('base_url');

    const ok = await postJson<{ provider: Record<string, unknown> }>(
      '/api/v1/providers:import_catalog',
      { catalog_id: 'gateway', api_key: 'sk-x', base_url: 'https://gw.example/v1' },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.provider['base_url']).toBe('https://gw.example/v1');
  });

  it('answers 40004 for an entry with no importable models', async () => {
    await boot();
    const { body } = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'empty-models',
      api_key: 'sk-x',
    });
    expect(body.code).toBe(40004);
    expect(body.msg).toContain('no importable models');
  });

  it('answers 40003 when the target id is OAuth-managed', async () => {
    await boot(MANAGED_OPENAI_TOML);
    const { body } = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-x',
    });
    expect(body.code).toBe(40003);
  });

  it('answers 40417 when importing an unknown catalog id', async () => {
    await boot();
    const { body } = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'nope',
      api_key: 'sk-x',
    });
    expect(body.code).toBe(40417);
  });

  it('answers 50004 when the catalog is unavailable', async () => {
    setCatalogUpstreamForTest({ fetchImpl: catalogFetchFail() });
    await boot();
    const { body } = await postJson('/api/v1/providers:import_catalog', {
      catalog_id: 'openai',
      api_key: 'sk-x',
    });
    expect(body.code).toBe(50004);
  });

  // -------------------------------------------------------------------------
  // POST /providers:import_registry
  // -------------------------------------------------------------------------

  const REGISTRY_URL = 'https://internal.example/api.json';
  /** Two valid providers plus one invalid entry that must be skipped. */
  const REGISTRY_DOC = {
    'acme-claude': {
      id: 'acme-claude',
      name: 'Acme Claude',
      api: 'https://acme.example/anthropic',
      type: 'anthropic',
      models: {
        'claude-opus': {
          id: 'claude-opus',
          name: 'Claude Opus',
          limit: { context: 200000, output: 32000 },
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          support_efforts: ['low', 'high'],
          default_effort: 'high',
        },
      },
    },
    'acme-gpt': {
      id: 'acme-gpt',
      name: 'Acme GPT',
      api: 'https://acme.example/v1',
      type: 'openai',
      models: {
        'gpt-x': { id: 'gpt-x', limit: { context: 128000 } },
      },
    },
    'bad-entry': { id: 'bad-entry' },
  } as const;

  function registryFetch(doc: unknown, seen?: { authorization?: string }): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === REGISTRY_URL) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (seen !== undefined) seen.authorization = headers['Authorization'];
        return new Response(JSON.stringify(doc), { status: 200 });
      }
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('imports every valid registry entry with a source blob and full model metadata', async () => {
    const seen: { authorization?: string } = {};
    setCatalogUpstreamForTest({ fetchImpl: registryFetch(REGISTRY_DOC, seen) });
    await boot();
    const { status, body } = await postJson<{
      providers: Array<Record<string, unknown>>;
      models_imported: number;
    }>('/api/v1/providers:import_registry', { url: REGISTRY_URL, api_key: 'tok-1' });
    expect(status).toBe(201);
    expect(body.code).toBe(0);
    expect(body.data.models_imported).toBe(2);
    expect(body.data.providers.map((p) => p['id']).sort()).toEqual(['acme-claude', 'acme-gpt']);
    expect(seen.authorization).toBe('Bearer tok-1');

    const config = await readConfigToml();
    const providers = config['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['bad-entry']).toBeUndefined();
    expect(providers['acme-claude']).toMatchObject({
      type: 'anthropic',
      base_url: 'https://acme.example/anthropic',
      api_key: 'tok-1',
      source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'tok-1' },
    });
    const models = config['models'] as Record<string, Record<string, unknown>>;
    expect(models['acme-claude/claude-opus']).toMatchObject({
      provider: 'acme-claude',
      model: 'claude-opus',
      max_context_size: 200000,
      display_name: 'Claude Opus',
      support_efforts: ['low', 'high'],
      default_effort: 'high',
    });
    expect(models['acme-claude/claude-opus']?.['capabilities']).toEqual([
      'tool_use',
      'thinking',
      'image_in',
    ]);
    // No rich hints: the default capability set and declared context apply.
    expect(models['acme-gpt/gpt-x']).toMatchObject({
      max_context_size: 128000,
      capabilities: ['tool_use'],
    });
  });

  it('never touches the global default pointers on registry import', async () => {
    setCatalogUpstreamForTest({ fetchImpl: registryFetch(REGISTRY_DOC) });
    await boot(DEFAULTED_TOML);
    const { status } = await postJson('/api/v1/providers:import_registry', {
      url: REGISTRY_URL,
      api_key: 'tok-1',
    });
    expect(status).toBe(201);
    const config = await readConfigToml();
    expect(config['default_provider']).toBe('kimi');
    expect(config['default_model']).toBe('k2');
  });

  it('re-imports the same URL as a refresh: vanished providers dropped, survivors rebuilt', async () => {
    setCatalogUpstreamForTest({ fetchImpl: registryFetch(REGISTRY_DOC) });
    await boot(DEFAULTED_TOML);
    const first = await postJson('/api/v1/providers:import_registry', {
      url: REGISTRY_URL,
      api_key: 'tok-1',
    });
    expect(first.status).toBe(201);

    // Hand-edit one model alias: an import rebuilds listed providers from
    // scratch (remove-then-apply, the TUI import semantics), so hand edits to
    // a listed provider do NOT survive — only providers absent upstream get
    // dropped while unrelated entries stay untouched.
    const before = await readConfigToml();
    const beforeModels = before['models'] as Record<string, Record<string, unknown>>;
    beforeModels['acme-gpt/gpt-x'] = {
      ...beforeModels['acme-gpt/gpt-x'],
      betaApi: true,
      max_context_size: 1,
    };
    const { stringify: stringifyToml } = await import('smol-toml');
    await writeFile(join(home as string, 'config.toml'), stringifyToml(before), 'utf-8');

    // The upstream doc no longer lists acme-claude.
    const slimDoc = { 'acme-gpt': REGISTRY_DOC['acme-gpt'] };
    setCatalogUpstreamForTest({ fetchImpl: registryFetch(slimDoc) });
    const second = await postJson('/api/v1/providers:import_registry', {
      url: REGISTRY_URL,
      api_key: 'tok-2',
    });
    expect(second.status).toBe(201);

    const after = await readConfigToml();
    const providers = after['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['acme-claude']).toBeUndefined();
    expect(providers['acme-gpt']?.['api_key']).toBe('tok-2');
    const models = after['models'] as Record<string, Record<string, unknown>>;
    expect(models['acme-claude/claude-opus']).toBeUndefined();
    expect(models['acme-gpt/gpt-x']).toEqual({
      provider: 'acme-gpt',
      model: 'gpt-x',
      max_context_size: 128000,
      capabilities: ['tool_use'],
      display_name: 'gpt-x',
    });
    // The default pointing at an unrelated provider stays untouched.
    expect(after['default_model']).toBe('k2');
  });

  it('answers 40003 when a registry entry id is OAuth-managed', async () => {
    const managed = {
      'managed-one': {
        id: 'managed-one',
        name: 'Managed One',
        api: 'https://acme.example/v1',
        type: 'openai',
        models: { m: { id: 'm', limit: { context: 1 } } },
      },
    };
    const managedToml = [
      '[providers."managed-one"]',
      'type = "openai"',
      'api_key = "sk-managed"',
      'oauth = { storage = "file", key = "oauth/managed-one" }',
      '',
    ].join('\n');
    setCatalogUpstreamForTest({ fetchImpl: registryFetch(managed) });
    await boot(managedToml);
    const { body } = await postJson('/api/v1/providers:import_registry', {
      url: REGISTRY_URL,
      api_key: 'tok-1',
    });
    expect(body.code).toBe(40003);
  });

  it('answers 40005 when the registry is unreachable', async () => {
    setCatalogUpstreamForTest({
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    await boot();
    const { body } = await postJson('/api/v1/providers:import_registry', {
      url: REGISTRY_URL,
      api_key: 'tok-1',
    });
    expect(body.code).toBe(40005);
  });

  it('answers 40005 when the document has no valid entries', async () => {
    setCatalogUpstreamForTest({ fetchImpl: registryFetch({ bad: { id: 'bad' } }) });
    await boot();
    const { body } = await postJson('/api/v1/providers:import_registry', {
      url: REGISTRY_URL,
      api_key: 'tok-1',
    });
    expect(body.code).toBe(40005);
    expect(body.msg).toContain('no importable providers');
  });

  it('answers 40001 when url is missing', async () => {
    await boot();
    const { body } = await postJson('/api/v1/providers:import_registry', { api_key: 'tok-1' });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('url');
  });
});
