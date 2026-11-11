import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  applyManagedKimiCodeConfig,
  clearManagedKimiCodeConfig,
  defaultRefreshThreshold,
  fetchManagedKimiCodeModels,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthKey,
  resolveKimiTokenStorageName,
  type AuthManagedUsageResult,
  type AuthManagedUserInfoResult,
  type BearerTokenProvider,
  type KimiOAuthLoginOptions,
  type KimiOAuthLoginResult,
  type KimiOAuthLogoutResult,
  type KimiOAuthTokenRef,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import { IBootstrapService, IConfigService, IOAuthService, IOAuthToolkit, type ProviderConfig, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';

const credentialSchema = z.object({
  oauth_key: z.string().min(1),
  base_url: z.string().min(1).optional(),
  oauth_host: z.string().min(1).optional(),
  access_token: z.string().min(1),
  expires_at: z.number(),
}).strict();

export type HostCredential = z.infer<typeof credentialSchema>;

const updateSchema = z.union([
  z.object({ action: z.literal('put'), credential: credentialSchema }).strict(),
  z.object({ action: z.literal('revoke') }).strict(),
]);

export type HostCredentialUpdate = z.infer<typeof updateSchema>;

export interface LocalHostCredential {
  readonly credential: HostCredential;
  readonly refreshAt: number;
}

export async function localHostCredential(core: Scope): Promise<LocalHostCredential | undefined> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  await core.accessor.get(IOAuthService).getRegionAsync();
  const bootstrap = core.accessor.get(IBootstrapService);
  const configured = config.get<Record<string, ProviderConfig> | undefined>('providers')?.[KIMI_CODE_PROVIDER_NAME];
  const auth = resolveKimiCodeLoginAuth({
    configuredBaseUrl: configured?.baseUrl,
    configuredOAuthRef: configured?.oauth,
    env: {
      KIMI_CODE_BASE_URL: bootstrap.getEnv('KIMI_CODE_BASE_URL'),
      KIMI_CODE_OAUTH_HOST: bootstrap.getEnv('KIMI_CODE_OAUTH_HOST'),
      KIMI_OAUTH_HOST: bootstrap.getEnv('KIMI_OAUTH_HOST'),
    },
  });
  const oauthKey = resolveKimiCodeOAuthKey({ baseUrl: auth.baseUrl, oauthHost: auth.oauthHost });
  const storage = new FileTokenStorage(`${bootstrap.homeDir}/credentials`);
  const name = resolveKimiTokenStorageName({ oauthKey });
  const stored = await storage.load(name);
  if (stored === undefined || stored.refreshToken.length === 0) return undefined;
  const accessToken = await core.accessor
    .get(IOAuthToolkit)
    .tokenProvider(KIMI_CODE_PROVIDER_NAME, { key: oauthKey, oauthHost: auth.oauthHost })
    .getAccessToken();
  const token = (await storage.load(name)) ?? stored;
  return {
    credential: {
      oauth_key: oauthKey,
      base_url: auth.baseUrl,
      oauth_host: auth.oauthHost,
      access_token: accessToken,
      expires_at: token.expiresAt,
    },
    refreshAt: token.expiresAt - defaultRefreshThreshold(token.expiresIn),
  };
}

export class HostCredentialStore {
  private current: HostCredential | undefined;

  read(): HostCredential | undefined {
    return this.current;
  }

  write(credential: HostCredential): void {
    this.current = credential;
  }

  remove(): boolean {
    const existed = this.current !== undefined;
    this.current = undefined;
    return existed;
  }
}

function expired(credential: HostCredential): boolean {
  return credential.expires_at * 1000 <= Date.now();
}

function sameAccountTarget(a: HostCredential, b: HostCredential): boolean {
  return a.oauth_key === b.oauth_key && a.base_url === b.base_url && a.oauth_host === b.oauth_host;
}

export class HostCredentialToolkit implements IOAuthToolkit {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly base: Omit<IOAuthToolkit, '_serviceBrand'>,
    private readonly store: HostCredentialStore,
  ) {}

  login(providerName?: string, options?: KimiOAuthLoginOptions): Promise<KimiOAuthLoginResult> {
    if (!this.handles(providerName)) return this.base.login(providerName, options);
    return Promise.reject(new Error('This host uses the Kimi account of the computer that connects to it. Sign in on that computer.'));
  }

  logout(providerName?: string, oauthRef?: KimiOAuthTokenRef): Promise<KimiOAuthLogoutResult> {
    if (!this.handles(providerName)) return this.base.logout(providerName, oauthRef);
    this.store.remove();
    return Promise.resolve({ providerName: KIMI_CODE_PROVIDER_NAME, ok: true });
  }

  getCachedAccessToken(providerName?: string, oauthRef?: KimiOAuthTokenRef): Promise<string | undefined> {
    if (!this.handles(providerName)) return this.base.getCachedAccessToken(providerName, oauthRef);
    const credential = this.store.read();
    return Promise.resolve(credential === undefined || expired(credential) ? undefined : credential.access_token);
  }

  tokenProvider(providerName?: string, oauthRef?: KimiOAuthTokenRef): BearerTokenProvider {
    if (!this.handles(providerName)) return this.base.tokenProvider(providerName, oauthRef);
    return {
      getAccessToken: () =>
        new Promise<string>((resolve) => {
          resolve(this.accessToken());
        }),
    };
  }

  getManagedUsage(
    providerName?: string,
    options?: { readonly oauthRef?: KimiOAuthTokenRef; readonly baseUrl?: string },
  ): Promise<AuthManagedUsageResult> {
    if (!this.handles(providerName)) return this.base.getManagedUsage(providerName, options);
    return Promise.resolve({ kind: 'error', message: 'Account usage is available on the computer that connects to this host.' });
  }

  getManagedUserInfo(
    providerName?: string,
    options?: { readonly oauthRef?: KimiOAuthTokenRef; readonly baseUrl?: string },
  ): Promise<AuthManagedUserInfoResult> {
    if (!this.handles(providerName)) return this.base.getManagedUserInfo(providerName, options);
    return Promise.resolve({ kind: 'error', message: 'Account details are available on the computer that connects to this host.' });
  }

  private handles(providerName: string | undefined): boolean {
    return (providerName ?? KIMI_CODE_PROVIDER_NAME) === KIMI_CODE_PROVIDER_NAME;
  }

  private accessToken(): string {
    const credential = this.store.read();
    if (credential === undefined) {
      throw new Error('No Kimi credential has been shared with this host. Connect to it from Kimi Code on a signed-in computer.');
    }
    if (expired(credential)) {
      throw new Error(
        `The Kimi credential shared with this host expired at ${new Date(credential.expires_at * 1000).toISOString()}. It renews while Kimi Code on the connecting computer is running.`,
      );
    }
    return credential.access_token;
  }
}

function readConfig(config: IConfigService): ManagedKimiConfigShape {
  return {
    providers: structuredClone(config.inspect<Record<string, ProviderConfig>>('providers').userValue ?? {}) as ManagedKimiConfigShape['providers'],
    models: structuredClone(config.inspect<Record<string, ManagedKimiConfigShape['models']>[string]>('models').userValue),
    defaultModel: config.inspect<string>('defaultModel').userValue,
    thinking: structuredClone(config.inspect<ManagedKimiConfigShape['thinking']>('thinking').userValue),
    services: structuredClone(config.inspect<ManagedKimiConfigShape['services']>('services').userValue),
  };
}

async function writeConfig(config: IConfigService, next: ManagedKimiConfigShape): Promise<void> {
  await config.replace('providers', next.providers);
  await config.replace('models', next.models ?? {});
  await config.replace('services', next.services);
  await config.replace('defaultModel', next.defaultModel);
  await config.replace('thinking', next.thinking);
}

async function provisionModels(config: IConfigService, credential: HostCredential): Promise<void> {
  const models = await fetchManagedKimiCodeModels({ accessToken: credential.access_token, baseUrl: credential.base_url });
  const next = readConfig(config);
  applyManagedKimiCodeConfig(next, {
    models,
    baseUrl: credential.base_url,
    oauthKey: credential.oauth_key,
    oauthHost: credential.oauth_host,
    preserveDefaultModel: true,
  });
  await writeConfig(config, next);
}

export async function applyHostCredentialUpdate(
  core: Scope,
  store: HostCredentialStore,
  input: unknown,
): Promise<{ readonly applied: boolean }> {
  const update = updateSchema.parse(input);
  const config = core.accessor.get(IConfigService);
  await config.ready;
  if (update.action === 'revoke') {
    if (store.remove()) {
      const next = readConfig(config);
      clearManagedKimiCodeConfig(next);
      await writeConfig(config, next);
    }
    return { applied: true };
  }
  const incoming = update.credential;
  if (expired(incoming)) throw new Error('The shared Kimi credential has already expired');
  const previous = store.read();
  if (previous !== undefined && sameAccountTarget(previous, incoming) && previous.expires_at > incoming.expires_at) {
    return { applied: false };
  }
  store.write(incoming);
  const managed = config.get<Record<string, ProviderConfig> | undefined>('providers')?.[KIMI_CODE_PROVIDER_NAME];
  if (previous === undefined || !sameAccountTarget(previous, incoming) || managed?.oauth?.key !== incoming.oauth_key) {
    await provisionModels(config, incoming);
  }
  return { applied: true };
}

export function registerHostCredentialRoute(app: {
  post(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
}, core: Scope, store: HostCredentialStore): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/oauth/host-credential',
      success: { data: z.object({ applied: z.boolean() }) },
      description: 'Receive or revoke the inference credential shared by the connecting computer',
      tags: ['hosts'],
    },
    async (req: { body: unknown; id: string }, reply: { send(payload: unknown): void }) => {
      try {
        reply.send(okEnvelope(await applyHostCredentialUpdate(core, store, req.body), req.id));
      } catch (error) {
        reply.send(errEnvelope(40100, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(route.path, route.options, route.handler as never);
}
