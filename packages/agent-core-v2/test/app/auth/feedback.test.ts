import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackService } from '#/app/auth/feedbackService';
import type { IConfigService } from '#/app/config/config';
import type { IOAuthService } from '#/app/auth/auth';
import type { IModelService, ModelRecord } from '#/llm-adapter/model/model';
import type { IProviderService, ProviderConfig } from '#/llm-adapter/provider/provider';

const SUBMIT = {
  content: 'test',
  sessionId: 's1',
  version: 'kimi-code-1.0.0',
  os: 'Darwin',
  model: 'acme/k3',
};

function service(options: {
  providers?: Record<string, ProviderConfig>;
  models?: Record<string, ModelRecord>;
  oauth?: Partial<IOAuthService>;
}): FeedbackService {
  const providers = options.providers ?? {};
  const models = options.models ?? {};
  return new FeedbackService(
    { get: (name: string) => providers[name] } as IProviderService,
    { get: (id: string) => models[id] } as IModelService,
    { get: () => undefined } as unknown as IConfigService,
    {
      status: async () => ({ loggedIn: false }),
      getCachedAccessToken: async () => undefined,
      resolveTokenProvider: () => undefined,
      ...options.oauth,
    } as IOAuthService,
  );
}

describe('FeedbackService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts to the provider feedbackUrl with the provider api key and custom headers', async () => {
    const fetchMock = vi.fn(async () => Response.json({ feedback_id: 9 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = service({
      providers: {
        acme: {
          type: 'kimi',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'YOUR_API_KEY',
          feedbackUrl: 'https://registry.example.test/v1/feedback',
          customHeaders: { 'X-Custom-Gateway': 'internal' },
        },
      },
      models: {
        'acme/k3': { provider: 'acme', model: 'k3', maxContextSize: 131072 },
      },
    });

    await expect(svc.availability('acme/k3')).resolves.toEqual({ kind: 'ready' });
    await expect(svc.submit(SUBMIT, 'acme/k3')).resolves.toEqual({ kind: 'ok', feedbackId: 9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://registry.example.test/v1/feedback');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer YOUR_API_KEY');
    expect(headers.get('x-custom-gateway')).toBe('internal');
  });

  it('reads provider.env credentials instead of falling through to managed OAuth', async () => {
    const fetchMock = vi.fn(async () => Response.json({ feedback_id: 4 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = service({
      providers: {
        acme: {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          feedbackUrl: 'https://registry.example.test/v1/feedback',
          env: { OPENAI_API_KEY: 'YOUR_ENV_API_KEY' },
        },
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: 'https://managed.example.test/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'acme/gpt': { provider: 'acme', model: 'gpt', maxContextSize: 131072 },
      },
      oauth: {
        status: async () => ({ loggedIn: true, provider: KIMI_CODE_PROVIDER_NAME }),
      },
    });

    await expect(svc.submit({ ...SUBMIT, model: 'acme/gpt' }, 'acme/gpt')).resolves.toEqual({
      kind: 'ok',
      feedbackId: 4,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://registry.example.test/v1/feedback');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer YOUR_ENV_API_KEY');
  });

  it('reports a missing credential instead of posting to the provider base URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = service({
      providers: {
        acme: {
          type: 'kimi',
          baseUrl: 'https://registry.example.test/v1',
          feedbackUrl: 'https://registry.example.test/v1/feedback',
          oauth: { storage: 'file', key: 'oauth/acme' },
        },
      },
      models: {
        'acme/k3': { provider: 'acme', model: 'k3', maxContextSize: 131072 },
      },
    });

    await expect(svc.availability('acme/k3')).resolves.toEqual({
      kind: 'error',
      message: 'Provider "acme" declares feedback_url but has no OAuth token.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses managed OAuth when the active model has no feedbackUrl', async () => {
    const fetchMock = vi.fn(async () => Response.json({ feedback_id: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = service({
      providers: {
        acme: { type: 'openai', baseUrl: 'https://registry.example.test/v1', apiKey: 'YOUR_API_KEY' },
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: 'https://managed.example.test/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'acme/gpt': { provider: 'acme', model: 'gpt', maxContextSize: 131072 },
      },
      oauth: {
        status: async () => ({ loggedIn: true, provider: KIMI_CODE_PROVIDER_NAME }),
        getCachedAccessToken: async () => 'managed-token',
        resolveTokenProvider: () => ({ getAccessToken: async () => 'managed-token' }),
      },
    });

    await expect(svc.availability('acme/gpt')).resolves.toEqual({ kind: 'ready' });
    await expect(svc.submit(SUBMIT, 'acme/gpt')).resolves.toEqual({ kind: 'ok', feedbackId: 2 });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://managed.example.test/v1/feedback',
    );
  });

  it('asks for login when neither a provider feedbackUrl nor a managed token is available', async () => {
    const svc = service({
      models: { 'acme/gpt': { provider: 'acme', model: 'gpt', maxContextSize: 8 } },
      providers: { acme: { type: 'openai', apiKey: 'YOUR_API_KEY' } },
    });
    await expect(svc.availability('acme/gpt')).resolves.toEqual({ kind: 'needs-login' });
  });
});
