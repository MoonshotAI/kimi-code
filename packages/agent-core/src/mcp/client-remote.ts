import type { McpRemoteServerConfig, McpServerConfig } from '#/config/schema';
import { ErrorCodes, KimiError } from '#/errors';
import { createProxyDispatcher } from '#/utils/proxy';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

export function buildMcpRemoteHeaders(
  config: McpRemoteServerConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...config.headers };
  if (config.bearerTokenEnvVar !== undefined) {
    const token = envLookup(config.bearerTokenEnvVar);
    if (token === undefined || token.length === 0) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `MCP ${config.transport.toUpperCase()} bearer token env var "${config.bearerTokenEnvVar}" is not set or is empty`,
      );
    }
    // Strip any case-variant 'authorization' static header before injecting the
    // bearer; Fetch Headers folds duplicate keys into a comma-joined value,
    // which produces an invalid auth header rather than letting the bearer win.
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

// Node's global fetch negotiates HTTP/2 (undici `allowH2` defaults to true).
// When the MCP SDK's streamable-HTTP transport then opens its standalone SSE
// GET stream on that H2 connection, undici queues every later stream-bodied
// POST behind the in-flight GET and never dispatches it (undici client-h2
// `busy()` guard; nodejs/undici#5524, fixed but not yet released). The GET
// stream never ends, so `tools/list` hangs until the startup handshake times
// out. Pinning remote MCP traffic to HTTP/1.1 puts the stream and the POSTs
// on separate connections, which every spec-compliant server handles.
//
// The pin must also reach proxy dispatchers: undici's EnvHttpProxyAgent /
// ProxyAgent negotiate H2 to the origin after the CONNECT tunnel as well.
// (The SOCKS path builds its own Agent with a plain connector — HTTP/1.1 by
// construction — so only the HTTP-proxy factory needs the flag.)
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

/**
 * `fetch` for remote MCP transports, pinned to HTTP/1.1 for direct
 * connections (see above). Tests can inject their own fetch via the client
 * options, or a custom dispatcher here, e.g. an H2-capable agent to
 * reproduce the stall this works around.
 */
export function createMcpFetch(dispatcher: Dispatcher = getMcpDispatcher()): typeof fetch {
  return ((input: unknown, init?: object) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher,
    })) as unknown as typeof fetch;
}
