import type { McpRemoteServerConfig, McpServerConfig } from '#/config/schema';
import { ErrorCodes, KimiError } from '#/errors';
import { createProxyDispatcher } from '#/utils/proxy';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

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
// GET stream and sends POSTs over that one H2 connection, Cloudflare-hosted
// MCP servers (including Cloudflare's own docs endpoint) stall the POST
// indefinitely while the GET stream is open — the startup handshake times out
// before `tools/list` ever resolves. Pinning remote MCP traffic to HTTP/1.1
// puts the stream and the POSTs on separate connections, which every
// spec-compliant server handles.
//
// When a proxy is configured the proxy dispatcher is used as-is: undici's
// CONNECT tunnels already speak HTTP/1.1 to the origin, so proxied traffic
// never hits the H2 stall.
let sharedMcpDispatcher: Dispatcher | undefined;

function getMcpDispatcher(): Dispatcher {
  if (sharedMcpDispatcher === undefined) {
    sharedMcpDispatcher = createProxyDispatcher() ?? new Agent({ allowH2: false });
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
