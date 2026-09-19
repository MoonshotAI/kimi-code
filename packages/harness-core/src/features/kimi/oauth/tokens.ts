import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CatalogOAuthRef } from '@moonshot-ai/agent-core';
import {
  FileTokenStorage,
  KIMI_CODE_FLOW_CONFIG,
  OAuthManager,
  resolveKimiTokenStorageName,
  type BearerTokenProvider,
  type KimiRegion,
  type ManagedUsageResult,
  type ManagedUserInfoResult,
} from '@moonshot-ai/kimi-code-oauth';

import type {
  AuthSummary,
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResult,
  OAuthLoginStartInput,
  OAuthLogoutResult,
} from './auth';

export interface OAuthTokens {
  resolve(ref: CatalogOAuthRef): BearerTokenProvider | undefined;
  refresh(): void;
  loginStart(input?: OAuthLoginStartInput): Promise<OAuthFlowStart>;
  loginStatus(provider?: string): OAuthFlowSnapshot | undefined;
  loginCancel(provider?: string): OAuthLoginCancelResult;
  logout(provider?: string): Promise<OAuthLogoutResult>;
  usage(provider?: string): Promise<ManagedUsageResult>;
  userinfo(provider?: string): Promise<ManagedUserInfoResult>;
  region(): KimiRegion;
  summary(): Promise<AuthSummary>;
}

export interface OAuthTokenResolver {
  resolve(ref: CatalogOAuthRef): BearerTokenProvider | undefined;
  manager(ref: CatalogOAuthRef): OAuthManager | undefined;
}

export function resolveOauthHome(home?: string): string {
  return home ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function createOAuthTokenResolver(home: string): OAuthTokenResolver {
  const storage = new FileTokenStorage(join(home, 'credentials'));
  const managers = new Map<string, OAuthManager>();
  const managerFor = (ref: CatalogOAuthRef): OAuthManager | undefined => {
    if (ref.storage !== 'file') return undefined;
    let name: string;
    try {
      name = resolveKimiTokenStorageName({ oauthKey: ref.key });
    } catch {
      return undefined;
    }
    const oauthHost = ref.oauthHost ?? KIMI_CODE_FLOW_CONFIG.oauthHost;
    const cacheKey = `${name}\0${oauthHost}`;
    let manager = managers.get(cacheKey);
    if (manager === undefined) {
      manager = new OAuthManager({
        config: { ...KIMI_CODE_FLOW_CONFIG, name, oauthHost },
        storage,
        configDir: home,
      });
      managers.set(cacheKey, manager);
    }
    return manager;
  };
  return {
    resolve: (ref) => {
      const manager = managerFor(ref);
      if (manager === undefined) return undefined;
      return {
        getAccessToken: (options) => manager.ensureFresh({ force: options?.force }),
      };
    },
    manager: managerFor,
  };
}
