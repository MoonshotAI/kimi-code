/**
 * Protocol loading — the debug surface's `GET /api/v1/debug/channels`
 * endpoint is the server's self-description of every wire-callable Service
 * (name, scope, domain, methods + properties), whitelist-free. Paired with
 * `serviceByName`, each descriptor materializes 1:1 into a typed proxy of
 * the channel layer: same channel name, same scope route, methods invoked by
 * reflection.
 *
 * `/api/v1/debug` is the ONLY RPC surface this app talks to (mounted by
 * kap-server with `--debug-endpoints` on a loopback bind); the v2 surface
 * (`/api/v2` + `/api/v2/ws`) was removed server-side, so there is no
 * fallback — `probeDebugSurface` fails the connection with a clear error.
 */

import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

import { DEBUG_RPC_BASE, type InspectClient } from './client';
import { RPCError } from './errors';
import type { ServiceProxy } from './channel';

/** Wire scope kinds reported by the channels endpoint (`app` ≡ the core route). */
export type ChannelScope = 'app' | 'session' | 'agent';

/** Mirror of `ChannelDescriptor` in kap-server (`GET /api/v1/debug/channels`). */
export interface ChannelDescriptor {
  readonly name: string;
  readonly scope: ChannelScope;
  readonly domain: string;
  readonly methods: readonly {
    readonly name: string;
    readonly kind: 'method' | 'property';
    readonly arity: number;
    readonly params: string;
  }[];
}

/** Fetch the dynamic channel list (unwrapped from the project envelope). */
export async function fetchChannelDescriptors(
  client: InspectClient,
): Promise<readonly ChannelDescriptor[]> {
  const headers: Record<string, string> = {};
  if (client.token !== undefined && client.token !== '') {
    headers['authorization'] = `Bearer ${client.token}`;
  }
  const res = await fetch(`${client.baseUrl}${DEBUG_RPC_BASE}/channels`, { headers });
  const envelope = (await res.json()) as {
    code: number;
    msg: string;
    data: readonly ChannelDescriptor[];
  };
  if (envelope.code !== 0) throw new RPCError(envelope.code, envelope.msg);
  return envelope.data;
}

/**
 * Verify the server mounts the debug RPC surface before the client is built.
 * Resolves silently when `GET /api/v1/debug/channels` answers with a
 * zero-code envelope; otherwise throws an `Error` whose message tells the
 * user exactly what is wrong (unreachable server, surface not mounted →
 * start kap-server with `--debug-endpoints`, or a rejected probe → check the
 * token).
 */
export async function probeDebugSurface(options: {
  readonly baseUrl: string;
  readonly token?: string;
}): Promise<void> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined && options.token !== '') {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  const url = `${options.baseUrl.replace(/\/$/, '')}${DEBUG_RPC_BASE}/channels`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot reach ${options.baseUrl} — is kap-server running? (${reason})`);
  }
  if (!res.ok) {
    throw new Error(
      `GET ${DEBUG_RPC_BASE}/channels answered HTTP ${res.status} — this server does not ` +
        'mount the debug RPC surface. Start kap-server with --debug-endpoints on a loopback bind.',
    );
  }
  const envelope = (await res.json()) as { code?: number; msg?: string };
  if (envelope.code !== 0) {
    throw new Error(
      `the debug surface rejected the probe (code ${envelope.code ?? '?'}: ${
        envelope.msg ?? 'no message'
      }) — check the bearer token.`,
    );
  }
}

export interface ServiceTarget {
  readonly scope: ChannelScope;
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * Resolve a Service proxy by wire channel name. The DI decorator registry keys
 * identifiers by name, so re-creating the decorator resolves to the same token
 * the server channel registry created — the name is the wire channel, which is
 * all the proxy uses. Returns `undefined` when the target scope needs a
 * session/agent id that isn't available.
 */
export function serviceByName<T extends object>(
  client: InspectClient,
  name: string,
  target: ServiceTarget,
): ServiceProxy<T> | undefined {
  const id = createDecorator<T>(name);
  if (target.scope === 'app') return client.core(id);
  if (target.sessionId === undefined) return undefined;
  const base = client.session(target.sessionId);
  if (target.scope === 'session') return base.service(id);
  if (target.agentId === undefined) return undefined;
  return base.agent(target.agentId).service(id);
}
