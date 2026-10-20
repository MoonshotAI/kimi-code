import { Agent, EnvHttpProxyAgent } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import {
  credentialsRecovery,
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
} from '#/llm/builtin/policy/credentials';
import { endpointIdentity } from '#/llm/builtin/policy/store-ref/account';
import { structureRecovery } from '#/llm/builtin/policy/structure';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { resolveEndpoint } from '#/llm/endpoint';
import { createAssistantMessage, createToolMessage, createUserMessage } from '#/llm/message';
import {
  createRecoveryLedger,
  proposeFirst,
  type LlmRecovery,
  type LlmRecoveryContext,
  type LlmRecoveryRecord,
} from '#/llm/policy/recovery';
import { isRetryableError, shouldRetry } from '#/llm/policy/retry';
import type { Protocol } from '#/llm/protocol/protocol';
import { toLlmStatusErrorMessage } from '#/llm/protocol/rules/status';
import type {
  LlmCredentialProvider,
  LlmEndpoint,
  LlmModelSpec,
  LlmProtocolBinding,
} from '#/llm/request';
import { createRequester } from '#/llm/requester';
import { llmStatusErrorMessage, type LlmRemoteErrorMessage } from '#/llm/response';
import { endpointFromEnv } from '#/node/env';
import { createHeadersTimeoutFetch, headersTimeoutDispatcher } from '#/node/fetch';

const ENDPOINT: LlmEndpoint = {
  baseUrl: 'https://explicit.test',
  headers: { 'x-base': '1' },
};

const ENV_NAMES = { apiKey: 'LLM_MEDIA_TEST_API_KEY', baseUrl: 'LLM_MEDIA_TEST_BASE_URL' };

describe('createStaticCredentialProvider', () => {
  it('resolves the static api key and never recovers', async () => {
    const provider = createStaticCredentialProvider('sk-1');
    expect(await provider.resolve()).toEqual({ apiKey: 'sk-1' });
    expect(provider.canRecover).toBeUndefined();
    expect(provider.invalidate).toBeUndefined();
  });

  it('resolves undefined for missing or blank keys', async () => {
    expect(await createStaticCredentialProvider(undefined).resolve()).toBeUndefined();
    expect(await createStaticCredentialProvider('   ').resolve()).toBeUndefined();
  });
});

describe('createOAuthCredentialProvider', () => {
  it('refreshes with force on invalidate and consumes the refresh on the next resolve', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    await provider.resolve();
    await provider.resolve();
    provider.invalidate?.();
    await provider.resolve();
    await provider.resolve();

    expect(calls).toEqual([undefined, undefined, true, undefined]);
  });

  it('starts the forced refresh eagerly on invalidate, before the next resolve', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    provider.invalidate?.();

    expect(calls).toEqual([true]);

    await provider.resolve();

    expect(calls).toEqual([true]);
  });

  it('coalesces repeated invalidates into a single refresh', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    provider.invalidate?.();
    provider.invalidate?.();
    await provider.resolve();

    expect(calls).toEqual([true]);
  });

  it('propagates a failed refresh to the consuming resolve and recovers afterwards', async () => {
    let calls = 0;
    const provider = createOAuthCredentialProvider(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('login required')) : Promise.resolve('tok');
    });

    provider.invalidate?.();

    await expect(provider.resolve()).rejects.toThrow('login required');
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'tok' });
  });

  it('recovers only from 401 errors', () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve('tok'));
    expect(provider.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(provider.canRecover?.(new Error('boom'))).toBe(false);
  });

  it('resolves undefined when the token source has no token', async () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve(undefined));
    await expect(provider.resolve()).resolves.toBeUndefined();
  });
});

describe('resolveEndpoint', () => {
  it('reads endpoints from env on the node side and keeps headers when there are no credentials', async () => {
    const env = { LLM_MEDIA_TEST_API_KEY: 'env-key', LLM_MEDIA_TEST_BASE_URL: 'https://env.test' };
    const fromEnv = endpointFromEnv(ENV_NAMES, env);
    expect(fromEnv.baseUrl).toBe('https://env.test');
    expect(await resolveEndpoint({ ...ENDPOINT, ...fromEnv, baseUrl: ENDPOINT.baseUrl })).toEqual({
      baseUrl: 'https://explicit.test',
      apiKey: 'env-key',
      headers: { 'x-base': '1' },
    });
    expect(endpointFromEnv(ENV_NAMES, { LLM_MEDIA_TEST_API_KEY: '' })).toEqual({});
    expect(await resolveEndpoint({ defaultBaseUrl: 'https://default.test' })).toMatchObject({
      baseUrl: 'https://default.test',
      apiKey: undefined,
    });
  });

  it('overrides the api key and merges headers from credentials and wires the node fetch', async () => {
    const resolved = await resolveEndpoint({
      ...ENDPOINT,
      credentials: { resolve: () => ({ apiKey: 'fresh', headers: { 'x-auth': 't' } }) },
    });
    expect(resolved.apiKey).toBe('fresh');
    expect(resolved.headers).toEqual({ 'x-base': '1', 'x-auth': 't' });

    const jwt = (payload: object, signature: string) =>
      ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), signature].join('.');
    expect(await endpointIdentity({ apiKey: jwt({ sub: 'u1' }, 'a') })).toBe(
      await endpointIdentity({ apiKey: jwt({ sub: 'u1' }, 'b') }),
    );
    expect(await endpointIdentity({ apiKey: 'sk-1' })).not.toBe(await endpointIdentity({ apiKey: 'sk-2' }));
    expect(await endpointIdentity({ apiKey: 'sk-1', headers: { Authorization: 'Bearer t' } })).toBe(
      await endpointIdentity({ headers: { authorization: 'Bearer t' } }),
    );
    expect(await endpointIdentity({})).toBe('no-key');

    expect(() => headersTimeoutDispatcher(-1, {})).toThrow('positive integer');
    expect(headersTimeoutDispatcher(1500, {})).toBeInstanceOf(Agent);
    expect(
      headersTimeoutDispatcher(1500, { HTTPS_PROXY: 'http://proxy.example.test:8080' }),
    ).toBeInstanceOf(EnvHttpProxyAgent);
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(headersTimeoutDispatcher(1500, { ALL_PROXY: 'socks5://proxy.example.test:1080' })).toBeUndefined();
    expect(createHeadersTimeoutFetch(1500, { ALL_PROXY: 'socks5://proxy.example.test:1080' })).toBe(fetch);
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('SOCKS'));
    emitWarning.mockRestore();
    const nodeFetch = createHeadersTimeoutFetch(1500, {});
    expect(nodeFetch).not.toBe(fetch);
    const client = openAIProtocol.client(await resolveEndpoint({ fetch: nodeFetch }), undefined) as unknown as {
      readonly fetch?: unknown;
    };
    expect(client.fetch).toBe(nodeFetch);
  });
});

function recoveryContext(
  error: unknown,
  appliedRecoveries: readonly LlmRecoveryRecord[] = [],
  credentials?: LlmCredentialProvider,
): LlmRecoveryContext {
  return {
    error: error as LlmRecoveryContext['error'],
    messages: [],
    appliedRecoveries,
    endpoint: credentials === undefined ? undefined : { credentials },
  };
}

const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
const forbidden = Object.assign(new Error('forbidden'), { status: 403 });

const REQUEST_MODEL: LlmModelSpec = {
  provider: 'test',
  name: 'test',
};

function statusError(
  kind: 'rate_limit' | 'status' | 'auth',
  statusCode: number,
  retryAfterMs: number | null = 1,
): LlmRemoteErrorMessage {
  return {
    kind,
    message: kind,
    statusCode,
    requestId: null,
    retryAfterMs,
    headers: null,
  };
}

function failingThenDone(failures: readonly LlmRemoteErrorMessage[]): LlmProtocolBinding {
  let calls = 0;
  const reply = async <T>(body: T) => {
    const error = failures[calls];
    calls += 1;
    if (error !== undefined) throw error;
    return { body };
  };
  const base: Protocol<unknown, unknown, string, string, unknown> = {
    media: { kinds: {} },
    encode: () => ({}),
    decoder: (_input, sink) => ({ push: (chunk) => sink.onDelta({ type: 'text', text: chunk }), end: () => {} }),
    replay: (response) => [response],
    decodeError: (error) => error as LlmRemoteErrorMessage,
    client: () => ({}),
    send: () => reply('ok'),
    sendStream: () => reply((async function* () { yield 'ok'; })()),
  };
  return { base };
}

describe('llm request policy', () => {
  it('keeps the default retryable table and only adds extras', () => {
    expect(isRetryableError({ kind: 'connection', message: 'x' })).toBe(true);
    expect(isRetryableError(statusError('rate_limit', 429))).toBe(true);
    expect(isRetryableError(statusError('status', 418))).toBe(false);
    expect(isRetryableError(statusError('auth', 401))).toBe(true);
    expect(isRetryableError({ kind: 'unknown', message: 'x' })).toBe(false);
    const infinite = { infiniteRetry: true };
    expect(shouldRetry(infinite, 99, { kind: 'unknown', message: 'x' })).toBe(true);
    expect(shouldRetry(infinite, 99, statusError('status', 418))).toBe(true);
    expect(shouldRetry(infinite, 1, { kind: 'context_overflow', message: 'x', statusCode: 400, requestId: null, retryAfterMs: null, headers: null })).toBe(false);
    expect(shouldRetry(infinite, 1, { kind: 'syntax', message: 'x', code: 'internal' })).toBe(false);
    expect(shouldRetry({ maxAttemptsPerStep: 2 }, 2, statusError('rate_limit', 429))).toBe(false);
    expect(isRetryableError({ kind: 'unknown', message: 'x' }, [() => true])).toBe(true);
    expect(isRetryableError({ kind: 'syntax', message: 'x', code: 'internal' }, [() => true])).toBe(
      false,
    );
    expect(isRetryableError({ kind: 'abort', message: 'x' }, [() => true])).toBe(false);
    expect(isRetryableError(statusError('rate_limit', 429), [() => false])).toBe(true);
  });

  it('classifies 401/403 status errors as auth and retries them', () => {
    for (const statusCode of [401, 403]) {
      const error = toLlmStatusErrorMessage({ statusCode, message: 'unauthorized' });
      expect(error).toMatchObject({
        kind: 'auth',
        statusCode,
        requestId: null,
        retryAfterMs: null,
        headers: null,
      });
      expect(llmStatusErrorMessage(error)?.statusCode).toBe(statusCode);
      expect(isRetryableError(error)).toBe(true);
    }
    expect(toLlmStatusErrorMessage({ statusCode: 418, message: 'teapot' }).kind).toBe('status');
  });

  it('retries a rate-limit error then succeeds', async () => {
    const events: string[] = [];
    const result = await createRequester().generate(
      {
        protocol: failingThenDone([statusError('rate_limit', 429)]),
        model: { spec: REQUEST_MODEL },
        content: { messages: [] },
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          events.push(event.type === 'llm.retrying' ? `${event.type}:${event.reason}` : event.type);
        },
      },
    );
    expect(result.type).toBe('done');
    expect(events[0]).toBe('llm.started');
    expect(events).toContain('llm.retrying:backoff');
    expect(events.at(-1)).toBe('llm.ended');
  });

  it('recovers credentials before retrying the same request', async () => {
    let invalidations = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => ({ apiKey: 'tok' }),
      canRecover: () => true,
      invalidate: () => {
        invalidations += 1;
      },
    };
    const events: string[] = [];
    const ledger = createRecoveryLedger();
    const requestOnce = () =>
      createRequester().generate(
        {
          protocol: failingThenDone([statusError('auth', 401)]),
          endpoint: { credentials: provider },
          model: { spec: REQUEST_MODEL },
          content: { messages: [] },
          policy: { recoveries: [credentialsRecovery] },
        },
        {
          signal: new AbortController().signal,
          recoveries: ledger,
          onEvent: (event) => {
            events.push(event.type === 'llm.retrying' ? `${event.type}:${event.reason}` : event.type);
          },
        },
      );
    const result = await requestOnce();
    expect(result.type).toBe('done');
    expect(invalidations).toBe(1);
    expect(events).toContain('llm.retrying:recovery');
    expect(ledger.applied).toEqual([{ strategy: 'credentials', action: 'refresh' }]);
    events.length = 0;
    expect((await requestOnce()).type).toBe('done');
    expect(invalidations).toBe(1);
    expect(events).toContain('llm.retrying:backoff');
    expect(events).not.toContain('llm.retrying:recovery');
    expect(
      credentialsRecovery.propose(recoveryContext(unauthorized, [], provider)),
    ).toMatchObject({ strategy: 'credentials', action: 'refresh' });
    expect(credentialsRecovery.propose(recoveryContext(unauthorized))).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(unauthorized, [], createStaticCredentialProvider('sk-1')),
      ),
    ).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(forbidden, [], createOAuthCredentialProvider(() => Promise.resolve('tok'))),
      ),
    ).toBeUndefined();
  });

  it('proposeFirst skips no-op rewrites and the ledger replays recorded rewrites in order', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] }];
    const ctx: LlmRecoveryContext = {
      error: { kind: 'request_too_large', message: 'big', statusCode: 413, requestId: null, retryAfterMs: null, headers: null },
      messages,
      appliedRecoveries: [],
    };
    const skip: LlmRecovery = {
      propose: () => ({ strategy: 'skip', action: 'same', rewrite: (current) => current }),
    };
    const take: LlmRecovery = {
      propose: () => ({ strategy: 'take', action: 'ok' }),
    };
    expect(proposeFirst([skip, take], ctx)).toEqual({ strategy: 'take', action: 'ok' });

    const ledger = createRecoveryLedger();
    const marker = { role: 'user' as const, content: [{ type: 'text' as const, text: 'b' }] };
    ledger.record({ strategy: 'append', action: 'one', rewrite: (current) => [...current, marker] });
    ledger.record({ strategy: 'take', action: 'ok' });
    ledger.record({ strategy: 'trim', action: 'first', rewrite: (current) => current.slice(1) });
    expect(ledger.applied.map((record) => record.strategy)).toEqual(['append', 'take', 'trim']);
    expect(ledger.apply(messages)).toEqual([marker]);
    expect(ledger.apply([])).toEqual([]);

    const text = (value: string) => [{ type: 'text' as const, text: value }];
    const callA = { type: 'function' as const, id: 'a', name: 'lookup', arguments: '{}' };
    const history = [
      createAssistantMessage(text('lead')),
      createUserMessage('q'),
      createAssistantMessage([], [callA]),
      createToolMessage('a', 'A'),
      createAssistantMessage(text('again')),
      createAssistantMessage(text('x')),
    ];
    const structureError: LlmRecoveryContext = {
      ...ctx,
      error: { kind: 'request_structure', message: 'roles must alternate', statusCode: 400, requestId: null, retryAfterMs: null, headers: null },
    };
    const strict = structureRecovery.propose({ ...structureError, messages: history });
    expect(strict).toMatchObject({ strategy: 'structure', action: 'strict' });
    expect(
      structureRecovery.propose({ ...structureError, appliedRecoveries: [{ strategy: 'structure', action: 'strict' }] }),
    ).toBeUndefined();
    expect(structureRecovery.propose(ctx)).toBeUndefined();
    const repaired = strict?.rewrite?.(history) ?? [];
    expect(repaired.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(repaired[2]).toBe(history[3]);
    expect(repaired[3]).toMatchObject({ content: [...text('again'), ...text('x')], toolCalls: [] });
  });
});
