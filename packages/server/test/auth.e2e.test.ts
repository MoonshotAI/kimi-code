/**
 * `GET /api/v1/auth` + prompt-submit readiness-gate e2e tests (P2.1).
 *
 * Four fixture states cover acceptance:
 *   1. **Empty config**            → ready=false, providers_count=0; prompt
 *                                    submit blocked with `40110`.
 *   2. **Manual provider, no key** → ready=false (key gate not met);
 *                                    prompt submit blocked with `40111`.
 *   3. **Provider, no default**    → ready=false (no default_model);
 *                                    prompt submit blocked with `40113`.
 *   4. **Provider + key + model**  → ready=true; prompt submit gets past the
 *                                    gate (and may fail downstream — that's
 *                                    out of scope here).
 *
 * **Bootstrap**: each test seeds `<bridgeHome>/config.toml` BEFORE calling
 * `startServer` so KimiCore loads it on construction. The `homeDir` we pass
 * via `coreProcessOptions.homeDir` is also what `AuthSummaryServiceImpl` uses to
 * locate the credential dir — keeping the file paths in lockstep with prod.
 *
 * **Anti-corruption**: tests only use the public REST surface + `RunningServer`
 * accessor. No reaching into `IPromptService._injectActiveForTest` like the
 * lifecycle test — we want the real ensureReady → bridge.rpc.prompt path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authSummarySchema, type AuthSummary } from '@moonshot-ai/protocol';

import { IRestGateway, startServer, type RunningServer } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-auth-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-auth-home-'));
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
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

/**
 * Seed `<bridgeHome>/config.toml` BEFORE server boot. Path layout matches
 * `resolveConfigPath({homeDir})` exactly so KimiCore + AuthSummaryService
 * load the same file.
 */
function seedConfig(toml: string): void {
  writeFileSync(join(bridgeHome, 'config.toml'), toml, 'utf-8');
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

/* -------------------------------------------------------------------- */
/* GET /v1/auth — readiness snapshot                                    */
/* -------------------------------------------------------------------- */

describe('GET /api/v1/auth — readiness probe (P2.1 D2)', () => {
  it('returns ready=false + zero providers on empty config', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/auth' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<AuthSummary>(res.json());
    expect(env.code).toBe(0);
    const summary = authSummarySchema.parse(env.data);
    expect(summary).toEqual({
      ready: false,
      providers_count: 0,
      default_model: null,
      managed_provider: null,
    });
  });

  it('returns ready=false when provider exists but default_model missing', async () => {
    seedConfig(
      [
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/auth' });
    const env = envelopeOf<AuthSummary>(res.json());
    const summary = authSummarySchema.parse(env.data);
    expect(summary.ready).toBe(false);
    expect(summary.providers_count).toBe(1);
    expect(summary.default_model).toBeNull();
  });

  it('returns ready=true when provider + api_key + default_model are all set', async () => {
    seedConfig(
      [
        'default_model = "x"',
        '',
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/auth' });
    const env = envelopeOf<AuthSummary>(res.json());
    const summary = authSummarySchema.parse(env.data);
    expect(summary).toEqual({
      ready: true,
      providers_count: 1,
      default_model: 'x',
      managed_provider: null,
    });
  });

  it('surfaces managed_provider.unauthenticated when config has managed:kimi-code but no cached token', async () => {
    seedConfig(
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://example/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "oauth/kimi-code"',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/auth' });
    const env = envelopeOf<AuthSummary>(res.json());
    const summary = authSummarySchema.parse(env.data);
    expect(summary.managed_provider).toEqual({
      name: 'managed:kimi-code',
      status: 'unauthenticated',
    });
    // ready is still false — no default_model, even though provider exists
    expect(summary.ready).toBe(false);
  });
});

/* -------------------------------------------------------------------- */
/* POST /sessions/{sid}/prompts — readiness gate                         */
/* -------------------------------------------------------------------- */

describe('POST /api/v1/sessions/{sid}/prompts — readiness gate (P2.1 D1)', () => {
  it('returns 40110 with details=null on empty config', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40110);
    expect(env.data).toBeNull();
    expect(env.details).toBeNull();
  });

  it('returns 40111 with details.provider_id when manual provider has no api_key', async () => {
    seedConfig(
      [
        'default_model = "x"',
        '',
        '[providers.x]',
        'type = "kimi"',
        '# no api_key',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40111);
    expect(env.data).toBeNull();
    expect(env.details).toEqual({ provider_id: 'x' });
  });

  it('returns 40113 with details.model_id when default_model alias does not resolve', async () => {
    seedConfig(
      [
        'default_model = "missing-alias"',
        '',
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40113);
    expect(env.data).toBeNull();
    expect(env.details).toEqual({ model_id: 'missing-alias' });
  });

  it('returns 40113 when default_model is unset (no model_id detail)', async () => {
    seedConfig(
      [
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40113);
    // No model_id in details when default is simply unset — clients should
    // route to "select a model" UX rather than "this alias is broken".
    expect(env.details).toBeNull();
  });

  it('passes the readiness gate when provider + key + default_model are all set', async () => {
    seedConfig(
      [
        'default_model = "x"',
        '',
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: {
        content: [{ type: 'text', text: 'hello' }],
        model: 'x',
        thinking: 'off',
        permission_mode: 'manual',
        plan_mode: false,
      },
    });
    const env = envelopeOf<unknown>(res.json());
    // The gate passes; bridge.rpc.prompt then runs against the test fixture
    // which has no real model wired up. We assert the readiness codes are
    // NOT what we see — anything beyond P2.1's scope is "out of band".
    expect([40110, 40111, 40112, 40113]).not.toContain(env.code);
  });
});
