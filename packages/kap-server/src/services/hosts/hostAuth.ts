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
  tokenFromWire,
  tokenToWire,
  type ManagedKimiConfigShape,
  type TokenInfoWire,
} from '@moonshot-ai/kimi-code-oauth';
import { IBootstrapService, IConfigService, IOAuthService, IOAuthToolkit, type ProviderConfig, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import type { HostBridgeManager } from './hostBridgeManager';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number(),
  scope: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
}).strict();

const credentialSchema = z.object({
  token: tokenSchema,
  base_url: z.string().min(1).optional(),
  oauth_host: z.string().min(1).optional(),
  oauth_key: z.string().min(1),
}).strict();

export interface HostCredential {
  readonly token: TokenInfoWire;
  readonly base_url?: string;
  readonly oauth_host?: string;
  readonly oauth_key: string;
}

export type HostCredentialOffer =
  | { readonly type: 'auth'; readonly action: 'provision'; readonly credential: HostCredential }
  | { readonly type: 'auth'; readonly action: 'logout'; readonly oauth_key: string };

const requestSchema = z.union([
  z.object({ action: z.literal('provision'), credential: credentialSchema }).strict(),
  z.object({ action: z.literal('logout'), oauth_key: z.string().min(1) }).strict(),
]);

async function localHostAuth(core: Scope): Promise<{
  readonly token?: TokenInfoWire;
  readonly base_url?: string;
  readonly oauth_host?: string;
  readonly oauth_key: string;
}> {
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
  const token = await storage(core).load(resolveKimiTokenStorageName({ oauthKey }));
  return {
    token: token === undefined || token.refreshToken.length === 0 ? undefined : tokenToWire(token),
    base_url: auth.baseUrl,
    oauth_host: auth.oauthHost,
    oauth_key: oauthKey,
  };
}

export async function localHostCredential(core: Scope): Promise<HostCredential | undefined> {
  const auth = await localHostAuth(core);
  if (auth.token === undefined) return undefined;
  return { token: auth.token, base_url: auth.base_url, oauth_host: auth.oauth_host, oauth_key: auth.oauth_key };
}

function storage(core: Scope): FileTokenStorage {
  return new FileTokenStorage(`${core.accessor.get(IBootstrapService).homeDir}/credentials`);
}

export async function localHostCredentialKey(core: Scope): Promise<string> {
  return (await localHostAuth(core)).oauth_key;
}

export async function saveLocalHostCredential(core: Scope, credential: HostCredential): Promise<void> {
  await storage(core).save(resolveKimiTokenStorageName({ oauthKey: credential.oauth_key }), tokenFromWire(credential.token));
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

async function readRemoteCredential(core: Scope, oauthKey: string): Promise<HostCredential | undefined> {
  const token = await storage(core).load(resolveKimiTokenStorageName({ oauthKey }));
  if (token === undefined || token.refreshToken.length === 0) return undefined;
  const configured = core.accessor.get(IConfigService).get<Record<string, ProviderConfig> | undefined>('providers')?.[KIMI_CODE_PROVIDER_NAME];
  return {
    token: tokenToWire(token),
    base_url: configured?.baseUrl,
    oauth_host: configured?.oauth?.oauthHost,
    oauth_key: oauthKey,
  };
}

function expired(token: TokenInfoWire): boolean {
  return token.expires_at * 1000 <= Date.now();
}

export function toolkitWithRemoteRefresh(core: Scope, manager: () => HostBridgeManager | undefined): IOAuthToolkit {
  const toolkit = core.accessor.get(IOAuthToolkit);
  return {
    ...toolkit,
    getCachedAccessToken(provider, oauthRef) {
      return toolkit.getCachedAccessToken(provider, oauthRef);
    },
    tokenProvider(provider, oauthRef) {
      const base = toolkit.tokenProvider(provider, oauthRef);
      return {
        async getAccessToken(options) {
          const current = await localHostCredential(core);
          const remaining = current === undefined ? Number.POSITIVE_INFINITY : current.token.expires_at - Math.floor(Date.now() / 1000);
          if (current === undefined || (options?.force !== true && remaining >= defaultRefreshThreshold(current.token.expires_in))) {
            return base.getAccessToken(options);
          }
          const remote = manager();
          if (remote === undefined) return base.getAccessToken(options);
          const credential = await remote.refreshCredential();
          await saveLocalHostCredential(core, credential);
          return credential.token.access_token;
        },
      };
    },
    async getManagedUsage(provider, options) {
      await this.tokenProvider(provider, options?.oauthRef).getAccessToken();
      return toolkit.getManagedUsage(provider, options);
    },
    async getManagedUserInfo(provider, options) {
      await this.tokenProvider(provider, options?.oauthRef).getAccessToken();
      return toolkit.getManagedUserInfo(provider, options);
    },
    async logout(provider, oauthRef) {
      const result = await toolkit.logout(provider, oauthRef);
      await manager()?.connect();
      return result;
    },
  };
}

export function registerHostCredentialRoute(app: {
  post(path: string, options: { schema?: Record<string, unknown> }, handler: never): unknown;
}, core: Scope): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/oauth/host-credential',
      success: { data: z.object({ credential: credentialSchema.nullable() }) },
      description: 'Share account credentials with the connected local client',
      tags: ['hosts'],
    },
    async (req: { body: unknown; id: string }, reply: { send(payload: unknown): void }) => {
      try {
        const input = requestSchema.parse(req.body);
        const oauthKey = input.action === 'provision' ? input.credential.oauth_key : input.oauth_key;
        const name = resolveKimiTokenStorageName({ oauthKey });
        const config = core.accessor.get(IConfigService);
        await config.ready;
        if (input.action === 'logout') {
          await storage(core).remove(name);
          const next = readConfig(config);
          clearManagedKimiCodeConfig(next);
          await writeConfig(config, next);
          reply.send(okEnvelope({ credential: null }, req.id));
          return;
        }
        const local = input.credential;
        const remote = await readRemoteCredential(core, oauthKey);
        if (remote !== undefined && remote.token.refresh_token !== local.token.refresh_token) {
          if (expired(remote.token) && expired(local.token)) {
            throw new Error('The local and remote accounts both have expired credentials. Log in on this computer again.');
          }
          if (expired(remote.token)) await storage(core).save(name, tokenFromWire(local.token));
        } else if (remote === undefined) {
          await storage(core).save(name, tokenFromWire(local.token));
        }
        const credential = await readRemoteCredential(core, oauthKey);
        if (credential === undefined) throw new Error('Unable to provision the account on this host');
        await core.accessor.get(IOAuthToolkit).tokenProvider(KIMI_CODE_PROVIDER_NAME, {
          key: oauthKey,
          oauthHost: credential.oauth_host,
        }).getAccessToken();
        const current = await readRemoteCredential(core, oauthKey);
        if (current === undefined) throw new Error('Unable to refresh the account on this host');
        const models = await fetchManagedKimiCodeModels({ accessToken: current.token.access_token, baseUrl: credential.base_url });
        const next = readConfig(config);
        applyManagedKimiCodeConfig(next, {
          models,
          baseUrl: credential.base_url,
          oauthKey,
          oauthHost: credential.oauth_host,
          preserveDefaultModel: true,
        });
        await writeConfig(config, next);
        reply.send(okEnvelope({ credential: current }, req.id));
      } catch (error) {
        reply.send(errEnvelope(40100, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(route.path, route.options, route.handler as never);
}
