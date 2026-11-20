import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { createKimiServices, type KimiServices } from '@moonshot-ai/testkit/services';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackService } from '#/app/auth/feedbackService';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { IOAuthService } from '#/app/auth/auth';
import type { ISessionExportService } from '#/app/sessionExport/sessionExport';
import type { ModelRecord } from '#/provider-catalog/model/model';
import type { ProviderConfig } from '#/provider-catalog/provider/provider';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';

const SUBMIT = {
  content: 'test',
  sessionId: 's1',
  version: 'kimi-code-1.0.0',
  os: 'Darwin',
  model: 'acme/k3',
};

function service(options: {
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;
  models?: Record<string, ModelRecord>;
  defaultModel?: string;
  oauth?: Partial<IOAuthService>;
  bootstrap?: Partial<IBootstrapService>;
  sessionExport?: Partial<ISessionExportService>;
}): FeedbackService {
  const providers = options.providers ?? {};
  const models = options.models ?? {};
  return new FeedbackService(
    {
      getProviderConfig: (name: string) => providers[name],
      getDefaultProviderId: () => options.defaultProvider,
      getModelRecord: (id: string) => models[id],
      getDefaultModelId: () => options.defaultModel,
    } as unknown as IProviderCatalogService,
    { get: () => undefined } as unknown as IConfigService,
    {
      status: async () => ({ loggedIn: false }),
      getCachedAccessToken: async () => undefined,
      resolveTokenProvider: () => undefined,
      ...options.oauth,
    } as IOAuthService,
    options.bootstrap as IBootstrapService | undefined,
    options.sessionExport as ISessionExportService | undefined,
  );
}

describe('FeedbackService', () => {
  let services: KimiServices;
  const at = (path: string): string => `${services.origin}${path}`;

  beforeEach(() => {
    services = createKimiServices();
    vi.stubGlobal('fetch', services.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await services.close();
    services.verify();
  });

  it('posts to the provider feedbackUrl with the provider api key and custom headers', async () => {
    const svc = service({
      providers: {
        acme: {
          type: 'kimi',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'YOUR_API_KEY',
          feedbackUrl: at('/registry/v1/feedback'),
          customHeaders: { 'X-Custom-Gateway': 'internal' },
        },
      },
      models: {
        'acme/k3': { provider: 'acme', model: 'k3', maxContextSize: 131072 },
      },
    });

    await expect(svc.availability('acme/k3')).resolves.toEqual({ kind: 'ready' });
    await expect(svc.submit(SUBMIT, 'acme/k3')).resolves.toEqual({ kind: 'ok', feedbackId: 1 });
    const [request] = services.requests('feedback');
    expect(request?.path).toBe('/registry/v1/feedback');
    expect(request?.authorization).toBe('Bearer YOUR_API_KEY');
    expect(request?.headers['x-custom-gateway']).toBe('internal');
  });

  it('honors defaultModel, defaultProvider, and providerId precedence over provider', async () => {
    const svc = service({
      defaultModel: 'default-alias',
      defaultProvider: 'fallback-provider',
      providers: {
        'fallback-provider': {
          type: 'kimi',
          baseUrl: 'https://fallback.example.test/v1',
          apiKey: 'YOUR_API_KEY',
          feedbackUrl: at('/fallback/v1/feedback'),
        },
        'primary-provider': {
          type: 'kimi',
          baseUrl: 'https://primary.example.test/v1',
          apiKey: 'YOUR_API_KEY',
          feedbackUrl: at('/primary/v1/feedback'),
        },
      },
      models: {
        'default-alias': { model: 'k3', maxContextSize: 131072 },
        'dual-provider': {
          providerId: 'primary-provider',
          provider: 'fallback-provider',
          model: 'k3',
          maxContextSize: 131072,
        },
      },
    });

    await expect(svc.availability()).resolves.toEqual({ kind: 'ready' });
    await expect(svc.submit({ ...SUBMIT, model: null })).resolves.toEqual({
      kind: 'ok',
      feedbackId: 1,
    });
    await expect(svc.submit({ ...SUBMIT, model: 'dual-provider' }, 'dual-provider')).resolves.toEqual(
      { kind: 'ok', feedbackId: 2 },
    );
    expect(services.requests('feedback').map((request) => request.path)).toEqual([
      '/fallback/v1/feedback',
      '/primary/v1/feedback',
    ]);
  });

  it('reads provider.env credentials instead of falling through to managed OAuth', async () => {
    const svc = service({
      providers: {
        acme: {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          feedbackUrl: at('/registry/v1/feedback'),
          env: { OPENAI_API_KEY: 'YOUR_ENV_API_KEY' },
        },
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: at('/managed/v1'),
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
      feedbackId: 1,
    });
    const [request] = services.requests('feedback');
    expect(request?.path).toBe('/registry/v1/feedback');
    expect(request?.authorization).toBe('Bearer YOUR_ENV_API_KEY');
  });

  it('reports a missing credential instead of posting to the provider base URL', async () => {
    const svc = service({
      providers: {
        acme: {
          type: 'kimi',
          baseUrl: 'https://registry.example.test/v1',
          feedbackUrl: at('/registry/v1/feedback'),
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
    expect(services.requests()).toEqual([]);
  });

  it('uses managed OAuth when the active model has no feedbackUrl', async () => {
    const svc = service({
      providers: {
        acme: { type: 'openai', baseUrl: 'https://registry.example.test/v1', apiKey: 'YOUR_API_KEY' },
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: at('/managed/v1'),
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
    await expect(svc.submit(SUBMIT, 'acme/gpt')).resolves.toEqual({ kind: 'ok', feedbackId: 1 });
    expect(services.requests('feedback')[0]?.path).toBe('/managed/v1/feedback');
  });

  it('asks for login when neither a provider feedbackUrl nor a managed token is available', async () => {
    const svc = service({
      models: { 'acme/gpt': { provider: 'acme', model: 'gpt', maxContextSize: 8 } },
      providers: { acme: { type: 'openai', apiKey: 'YOUR_API_KEY' } },
    });
    await expect(svc.availability('acme/gpt')).resolves.toEqual({ kind: 'needs-login' });
  });

  it('returns the session file preview from availability and forwards sessionFiles to export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-svc-attachments-'));
    try {
      const workDir = join(root, 'work');
      const cacheDir = join(root, 'cache');
      const logsDir = join(root, 'logs');
      await rm(workDir, { recursive: true, force: true });
      await writeFile(join(root, 'dummy.txt'), 'ok');
      const preview = {
        sessionId: 's1',
        sessionDir: join(root, 'session'),
        files: ['agents/main/wire.jsonl', 'state.json'],
        requestId: 'req-latest-42',
      };
      const exportMock = vi.fn(async ({ outputPath }: { outputPath?: string }) => {
        await writeFile(outputPath!, 'session archive bytes');
        return {
          zipPath: outputPath!,
          entries: ['manifest.json', 'state.json'],
          sessionDir: join(root, 'session'),
          manifest: {} as never,
        };
      });

      const svc = service({
        providers: {
          acme: {
            type: 'kimi',
            baseUrl: 'https://registry.example.test/v1',
            apiKey: 'YOUR_API_KEY',
            feedbackUrl: at('/registry/v1/feedback'),
          },
        },
        models: {
          'acme/k3': { provider: 'acme', model: 'k3', maxContextSize: 131072 },
        },
        bootstrap: { cacheDir, logsDir },
        sessionExport: {
          preview: async () => preview,
          export: exportMock,
        },
      });

      await expect(svc.availability('acme/k3', 's1')).resolves.toEqual({
        kind: 'ready',
        session: {
          sessionId: 's1',
          sessionDir: join(root, 'session'),
          files: ['agents/main/wire.jsonl', 'state.json'],
        },
      });

      const result = await svc.submit(
        {
          ...SUBMIT,
          attachmentLevel: 'logs+codebase',
          workDir: root,
        },
        'acme/k3',
      );

      expect(result).toEqual({ kind: 'ok', feedbackId: 1 });
      const [feedback] = services.feedback();
      expect(feedback?.body).toMatchObject({ info: { request_id: 'req-latest-42' } });
      expect(exportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's1',
          includeGlobalLog: true,
          version: '1.0.0',
        }),
      );
      const uploads = new Map(feedback?.uploads.map((upload) => [upload.request['file_name'], upload]));
      expect([...uploads.keys()].toSorted()).toEqual(['repo.zip', 'session.zip']);
      expect(new TextDecoder().decode(uploads.get('session.zip')?.bytes)).toBe('session archive bytes');
      expect([...uploads.values()].every((upload) => upload.completion !== undefined)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors attachmentLevel none without uploading archives', async () => {
    const exportMock = vi.fn();

    const svc = service({
      providers: {
        acme: {
          type: 'kimi',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'YOUR_API_KEY',
          feedbackUrl: at('/registry/v1/feedback'),
        },
      },
      models: {
        'acme/k3': { provider: 'acme', model: 'k3', maxContextSize: 131072 },
      },
      sessionExport: {
        export: exportMock,
      },
    });

    await expect(
      svc.submit({ ...SUBMIT, attachmentLevel: 'none' }, 'acme/k3'),
    ).resolves.toEqual({ kind: 'ok', feedbackId: 1 });
    expect(exportMock).not.toHaveBeenCalled();
  });

  it('marks attachmentFailed when session export fails after feedback submission succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feedback-svc-partial-'));
    try {

      const svc = service({
        providers: {
          acme: {
            type: 'kimi',
            baseUrl: 'https://registry.example.test/v1',
            apiKey: 'YOUR_API_KEY',
            feedbackUrl: at('/registry/v1/feedback'),
          },
        },
        models: {
          'acme/k3': { provider: 'acme', model: 'k3', maxContextSize: 131072 },
        },
        bootstrap: { cacheDir: join(root, 'cache'), logsDir: join(root, 'logs') },
        sessionExport: {
          export: async () => {
            throw new Error('session not found');
          },
        },
      });

      const result = await svc.submit({ ...SUBMIT, attachmentLevel: 'logs' }, 'acme/k3');
      expect(result).toEqual({ kind: 'ok', feedbackId: 1, attachmentFailed: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
