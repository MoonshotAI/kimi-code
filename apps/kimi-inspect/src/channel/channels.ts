import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

import type { ServiceProxy } from './channel';
import { DEBUG_RPC_BASE, type InspectClient } from './client';
import { RPCError } from './errors';

export type ChannelScope = 'app' | 'session' | 'agent';

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
