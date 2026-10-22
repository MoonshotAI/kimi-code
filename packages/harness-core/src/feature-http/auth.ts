import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolvePasswordHash, verifyPassword } from './security/password';
import { createTokenStore } from './security/token-store';
import { WS_BEARER_PROTOCOL_PREFIX } from './ws-v1/protocol';

const BEARER_PREFIX = 'Bearer ';

export interface HttpAuthTokenService {
  getToken?(): string;
  isValid(candidate: string): boolean | Promise<boolean>;
}

export const _HOME = join(homedir(), '.kimi-code');

export const _PASSWORD: string | undefined = undefined;

export const _ALLOWED_HOSTS: readonly string[] = [];

export const _DISABLE_HOST_CHECK = false;

export interface HttpAuthOptions {
  readonly authTokenService?: HttpAuthTokenService;
  readonly disableAuth?: boolean;
  readonly HOME?: string;
  readonly PASSWORD?: string;
  readonly rpcToken?: string;
  readonly ALLOWED_HOSTS?: readonly string[];
  readonly DISABLE_HOST_CHECK?: boolean;
  readonly bindClass?: 'lan' | 'public';
  readonly corsOrigins?: readonly string[];
  readonly apiPrefixes?: readonly string[];
  readonly healthPath?: string;
}

export interface HttpAuthRuntime {
  readonly service: HttpAuthTokenService;
  readonly validateCredential: (candidate: string) => Promise<boolean>;
}

export async function initializeAuth(options: HttpAuthOptions): Promise<HttpAuthRuntime> {
  const service =
    options.authTokenService ??
    (await createDefaultAuthTokenService(options.HOME ?? _HOME, options.PASSWORD ?? _PASSWORD));
  return {
    service,
    validateCredential: async (candidate) => {
      if (await service.isValid(candidate)) return true;
      return options.rpcToken !== undefined && candidate.length > 0 && timingSafeMatch(candidate, options.rpcToken);
    },
  };
}

export function extractBearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : token;
}

export function extractWsBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const entry of header.split(',')) {
    const protocol = entry.trim();
    if (!protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX)) continue;
    const token = protocol.slice(WS_BEARER_PROTOCOL_PREFIX.length);
    return token.length === 0 ? null : token;
  }
  return null;
}

async function createDefaultAuthTokenService(home: string, password: string | undefined): Promise<HttpAuthTokenService> {
  const tokenStore = await createTokenStore(home);
  const passwordHash = await resolvePasswordHash(password);
  return {
    getToken: () => tokenStore.getToken(),
    isValid: async (candidate) =>
      tokenStore.isValid(candidate) || (await verifyPassword(candidate, passwordHash)),
  };
}

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
