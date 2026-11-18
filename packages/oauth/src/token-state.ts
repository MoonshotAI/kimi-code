import type { TokenInfo } from './types';

export type TokenState =
  | { readonly kind: 'valid'; readonly token: TokenInfo }
  | { readonly kind: 'revoked'; readonly scope: string; readonly tokenType: string }
  | { readonly kind: 'missing' };

export function classifyToken(token: TokenInfo | undefined): TokenState {
  if (token === undefined) return { kind: 'missing' };
  if (token.accessToken.length === 0) {
    return { kind: 'revoked', scope: token.scope, tokenType: token.tokenType };
  }
  return { kind: 'valid', token };
}

export function revokedTombstone(prior: TokenInfo): TokenInfo {
  return {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    scope: prior.scope,
    tokenType: prior.tokenType,
    expiresIn: 0,
  };
}
