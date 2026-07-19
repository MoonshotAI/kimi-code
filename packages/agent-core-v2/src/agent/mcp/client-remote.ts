/**
 * `mcp` domain — shared helpers for the remote (HTTP/SSE) MCP transports.
 *
 * Owns bearer-token header construction and the default `fetch` for remote
 * MCP traffic. The fetch is pinned to HTTP/1.1 (undici `allowH2: false`,
 * including through HTTP CONNECT proxies): Node's global fetch negotiates
 * HTTP/2, and undici then queues stream-bodied POSTs behind the in-flight
 * standalone SSE GET stream without dispatching them (undici client-h2
 * `busy()` guard, nodejs/undici#5524), hanging the MCP startup handshake
 * until `startupTimeoutMs` fires. Callers may still inject a custom `fetch`
 * (tests) or dispatcher (e.g. an H2-capable agent to reproduce the stall).
 */

import type { McpRemoteServerConfig, McpServerConfig } from './config-schema';
import { ErrorCodes, Error2 } from '#/errors';
import { createProxyDispatcher } from '#/_base/utils/proxy';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

export function buildMcpRemoteHeaders(
  config: McpRemoteServerConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...config.headers };
  if (config.bearerTokenEnvVar !== undefined) {
    const token = envLookup(config.bearerTokenEnvVar);
    if (token === undefined || token.length === 0) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `MCP ${config.transport.toUpperCase()} bearer token env var "${config.bearerTokenEnvVar}" is not set or is empty`,
      );
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') {
        delete headers[key];
      }
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function isRemoteMcpConfig(config: McpServerConfig): config is McpRemoteServerConfig {
  return config.transport === 'http' || config.transport === 'sse';
}

let sharedMcpDispatcher: Dispatcher | undefined;

function getMcpDispatcher(): Dispatcher {
  if (sharedMcpDispatcher === undefined) {
    sharedMcpDispatcher =
      createProxyDispatcher(process.env, {
        makeHttpAgent: ({ httpProxy, httpsProxy, noProxy }) =>
          new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy, allowH2: false }),
      }) ?? new Agent({ allowH2: false });
  }
  return sharedMcpDispatcher;
}

export function createMcpFetch(dispatcher: Dispatcher = getMcpDispatcher()): typeof fetch {
  return ((input: unknown, init?: object) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher,
    })) as unknown as typeof fetch;
}
