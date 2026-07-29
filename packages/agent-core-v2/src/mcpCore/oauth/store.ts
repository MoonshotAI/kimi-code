/**
 * `mcpCore` domain (L2) — MCP OAuth credential store port and key addressing.
 *
 * Defines the {@link McpOAuthStore} port the OAuth provider/service read and
 * write credentials through, plus the store-key scheme: one logical record
 * per `(serverName, serverUrl)` identity, addressed by {@link mcpOAuthStoreKey}
 * (sanitized name prefix + a digest of name and canonicalized URL). The
 * persistence implementation lives in the `mcpConfig` wrapper domain
 * (`IMcpOAuthStore`, backed by `IAtomicDocumentStore` under the
 * `credentials/mcp` scope); this file holds no IO.
 */

import { createHash } from 'node:crypto';

import { basename } from 'pathe';

export function sanitizeStoreKey(name: string): string {
  const safe = basename(name).replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

export interface McpOAuthStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, data: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
