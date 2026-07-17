/**
 * Protocol loading — the server's `{rpcBasePath}/channels` endpoint is its
 * self-description of every wire-callable Service (name, scope, domain,
 * methods + properties). On dev servers that's the whitelist-free
 * `/api/v1/debug`; older/production servers fall back to the `/api/v2`
 * whitelist set (`probeRpcBasePath` decides). Paired with `serviceByName`,
 * each descriptor materializes 1:1 into a typed proxy of the channel layer:
 * same channel name, same scope route, methods invoked by reflection.
 */

import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

import { RPCError } from './errors';
import type { InspectClient } from './client';
import type { ServiceProxy } from './channel';

/** Wire scope kinds reported by the channels endpoint (`app` ≡ the core route). */
export type ChannelScope = 'app' | 'session' | 'agent';

/** Mirror of `ChannelDescriptor` in kap-server (`GET /api/v2/channels`). */
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

/** Fetch the dynamic channel list (unwrapped from the project envelope),
 * from whichever RPC surface the connection probed (`rpcBasePath`). */
export async function fetchChannelDescriptors(
  client: InspectClient,
): Promise<readonly ChannelDescriptor[]> {
  const headers: Record<string, string> = {};
  if (client.token !== undefined && client.token !== '') {
    headers['authorization'] = `Bearer ${client.token}`;
  }
  const res = await fetch(`${client.baseUrl}${client.rpcBasePath}/channels`, { headers });
  const envelope = (await res.json()) as {
    code: number;
    msg: string;
    data: readonly ChannelDescriptor[];
  };
  if (envelope.code !== 0) throw new RPCError(envelope.code, envelope.msg);
  return envelope.data;
}

/** The dev server's whitelist-free debug surface (`--debug-endpoints`). */
export const DEBUG_RPC_BASE = '/api/v1/debug' as const;
/** The stable whitelist RPC surface — fallback when debug is not mounted. */
export const V2_RPC_BASE = '/api/v2' as const;

export type RpcBasePath = typeof DEBUG_RPC_BASE | typeof V2_RPC_BASE;

/**
 * Probe which RPC surface a server offers: dev servers started with
 * `--debug-endpoints` answer `/api/v1/debug/channels`; older/production
 * servers only the whitelisted `/api/v2`. Always resolves (fallback `/api/v2`).
 */
export async function probeRpcBasePath(options: {
  readonly baseUrl: string;
  readonly token?: string;
}): Promise<RpcBasePath> {
  try {
    const headers: Record<string, string> = {};
    if (options.token !== undefined && options.token !== '') {
      headers['authorization'] = `Bearer ${options.token}`;
    }
    const res = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}${DEBUG_RPC_BASE}/channels`,
      { headers },
    );
    if (res.ok) {
      const envelope = (await res.json()) as { code?: number };
      if (envelope.code === 0) return DEBUG_RPC_BASE;
    }
  } catch {
    // fall through to the v2 fallback
  }
  return V2_RPC_BASE;
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
