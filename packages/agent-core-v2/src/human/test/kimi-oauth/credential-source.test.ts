import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { StreamedMessagePart, VideoURLPart } from '#/llm/message';
import type { MediaVideoUploader } from '#/llm/media/upload';
import type { LlmErrorMessage } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import type { LlmRequestControl, LlmRequester } from '#/llm/requester/requester';
import {
  kimiOAuthCredentialSource,
  withAuth,
  withAuthUpload,
  type CredentialSource,
} from '#/kimi-oauth/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type GenerateArgs = Parameters<LlmRequester['generate']>;

function generateArgs(control: Partial<LlmRequestControl> = {}): GenerateArgs {
  return [{ model }, { messages: [] }, { signal: new AbortController().signal, ...control }];
}

function statusError(status: number): LlmErrorMessage {
  return {
    kind: 'status',
    statusCode: status,
    message: `status ${status}`,
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
}

interface InnerCall {
  readonly model: LlmModel;
}

function createInner(plan: readonly (LlmErrorMessage | 'ok')[]) {
  const calls: InnerCall[] = [];
  const requester: LlmRequester = {
    generate: (config, _content, { onEvent }) => {
      calls.push({ model: config.model });
      const step = plan[Math.min(calls.length - 1, plan.length - 1)];
      if (step === 'ok') {
        onEvent?.({
          type: 'llm.delta',
          part: { type: 'text', text: `call-${calls.length}` },
        });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      }
      onEvent?.({ type: 'llm.failed.remote', error: step });
      return Promise.resolve();
    },
  };
  return { requester, calls };
}

async function generateFailures(
  requester: LlmRequester,
  control: Partial<LlmRequestControl> = {},
): Promise<LlmErrorMessage[]> {
  const failures: LlmErrorMessage[] = [];
  await requester.generate(
    ...generateArgs({
      ...control,
      onEvent: (event) => {
        if (event.type === 'llm.failed.remote' || event.type === 'llm.failed.syntax') {
          failures.push(event.error);
        }
      },
    }),
  );
  return failures;
}

describe('withAuth', () => {
  it('resolves credentials before each generate and forwards the resolved model', async () => {
    const { requester, calls } = createInner(['ok']);
    const source: CredentialSource = {
      resolve: (m) => ({ ...m, apiKey: 'token-1' }),
    };
    const wrapped = withAuth(requester, source);

    const parts: StreamedMessagePart[] = [];
    await wrapped.generate(
      ...generateArgs({
        onEvent: (event) => {
          if (event.type === 'llm.delta') {
            parts.push(event.part);
          }
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toEqual({ ...model, apiKey: 'token-1' });
    expect(parts).toEqual([{ type: 'text', text: 'call-1' }]);
  });

  it('retries once with forced credentials when canRecover accepts the error', async () => {
    const { requester, calls } = createInner([statusError(401), 'ok']);
    const resolveOptions: unknown[] = [];
    const source: CredentialSource = {
      resolve: (m, options) => {
        resolveOptions.push(options);
        return { ...m, apiKey: options?.force === true ? 'token-2' : 'token-1' };
      },
      canRecover: (_m, error) => statusErrorStatus(error) === 401,
    };
    const wrapped = withAuth(requester, source);

    const parts: StreamedMessagePart[] = [];
    await wrapped.generate(
      ...generateArgs({
        onEvent: (event) => {
          if (event.type === 'llm.delta') {
            parts.push(event.part);
          }
        },
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.model.apiKey).toBe('token-1');
    expect(calls[1]?.model.apiKey).toBe('token-2');
    expect(resolveOptions).toEqual([undefined, { force: true }]);
    expect(parts).toEqual([{ type: 'text', text: 'call-2' }]);
  });

  it('emits the failure when the retry also fails', async () => {
    const { requester, calls } = createInner([statusError(401), statusError(401)]);
    const source: CredentialSource = {
      resolve: (m) => m,
      canRecover: () => true,
    };
    const wrapped = withAuth(requester, source);

    const failures = await generateFailures(wrapped);

    expect(calls).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'status', statusCode: 401 });
  });

  it('does not retry when canRecover rejects the error', async () => {
    const { requester, calls } = createInner([statusError(401)]);
    const source: CredentialSource = {
      resolve: (m) => m,
      canRecover: () => false,
    };
    const wrapped = withAuth(requester, source);

    const failures = await generateFailures(wrapped);

    expect(calls).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'status', statusCode: 401 });
  });

  it('does not retry when the source has no canRecover', async () => {
    const { requester, calls } = createInner([statusError(401)]);
    const wrapped = withAuth(requester, { resolve: (m) => m });

    const failures = await generateFailures(wrapped);

    expect(calls).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'status', statusCode: 401 });
  });

  it('does not retry when the signal is aborted', async () => {
    const { requester, calls } = createInner([statusError(401)]);
    const controller = new AbortController();
    controller.abort();
    const source: CredentialSource = {
      resolve: (m) => m,
      canRecover: () => true,
    };
    const wrapped = withAuth(requester, source);

    const failures = await generateFailures(wrapped, { signal: controller.signal });

    expect(calls).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'status', statusCode: 401 });
  });

  it('wraps uploadVideo with the same credential flow', async () => {
    const part: VideoURLPart = { type: 'video_url', videoUrl: { url: 'ms://file-1', id: 'file-1' } };
    const seen: (string | undefined)[] = [];
    let attempts = 0;
    const inner: MediaVideoUploader = (_video, options) => {
      attempts += 1;
      seen.push(options.model.apiKey);
      if (attempts === 1) {
        return Promise.reject(statusError(401));
      }
      return Promise.resolve(part);
    };
    const source: CredentialSource = {
      resolve: (m, options) => ({ ...m, apiKey: options?.force === true ? 'fresh' : 'stale' }),
      canRecover: () => true,
    };
    const wrapped = withAuthUpload(inner, source);

    const result = await wrapped({ data: new Uint8Array([1]), mimeType: 'video/mp4' }, { model });

    expect(result).toBe(part);
    expect(seen).toEqual(['stale', 'fresh']);
  });

  it('does not retry the upload when the signal is aborted', async () => {
    const failure = statusError(401);
    let attempts = 0;
    const inner: MediaVideoUploader = () => {
      attempts += 1;
      return Promise.reject(failure);
    };
    const controller = new AbortController();
    controller.abort();
    const wrapped = withAuthUpload(inner, {
      resolve: (m) => m,
      canRecover: () => true,
    });

    await expect(
      wrapped(
        { data: new Uint8Array([1]), mimeType: 'video/mp4' },
        { model, signal: controller.signal },
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});

describe('kimiOAuthCredentialSource', () => {
  function createTokens() {
    const calls: (boolean | undefined)[] = [];
    return {
      calls,
      tokens: {
        getAccessToken: (options?: { readonly force?: boolean }) => {
          calls.push(options?.force);
          return Promise.resolve('access-token');
        },
      },
    };
  }

  it('resolves the model apiKey from the token provider', async () => {
    const { calls, tokens } = createTokens();
    const source = kimiOAuthCredentialSource(tokens);

    const resolved = await source.resolve({ ...model, baseUrl: 'https://example.com/v1' });

    expect(resolved).toEqual({
      ...model,
      baseUrl: 'https://example.com/v1',
      apiKey: 'access-token',
    });
    expect(calls).toEqual([false]);
  });

  it('passes force through to the token provider', async () => {
    const { calls, tokens } = createTokens();
    const source = kimiOAuthCredentialSource(tokens);

    await source.resolve(model, { force: true });

    expect(calls).toEqual([true]);
  });

  it('recovers only from 401 errors', () => {
    const { tokens } = createTokens();
    const source = kimiOAuthCredentialSource(tokens);

    expect(source.canRecover?.(model, statusError(401))).toBe(true);
    expect(source.canRecover?.(model, Object.assign(new Error('x'), { statusCode: 401 }))).toBe(
      true,
    );
    expect(source.canRecover?.(model, statusError(403))).toBe(false);
    expect(source.canRecover?.(model, new Error('boom'))).toBe(false);
    expect(source.canRecover?.(model, 'nope')).toBe(false);
  });
});

function statusErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record['status'] ?? record['statusCode'];
  return typeof status === 'number' ? status : undefined;
}
