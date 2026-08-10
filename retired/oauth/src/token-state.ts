/**
 * Internal three-state view of what storage holds for a provider.
 *
 *   • valid    — a usable token. Refresh decisions are made elsewhere
 *                from `token.expiresAt`.
 *   • revoked  — a "tombstone": the on-disk file exists but the prior
 *                refresh_token was rejected (401/403). A fresh process
 *                with no in-memory state needs to see "previously logged
 *                in, now needs re-login" instead of "never logged in".
 *   • missing  — no file on disk.
 *
 * Wire format and `TokenInfo` are unchanged: a revoked record is still
 * persisted as `{ access_token: "", refresh_token: "", expires_at: 0,
 * scope, token_type, expires_in: 0 }`. This module exists so the
 * manager doesn't have to repeat that field-emptiness convention on
 * every branch.
 *
 * Package-private. NOT re-exported from `index.ts`.
 */

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
