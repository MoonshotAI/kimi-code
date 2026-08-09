/**
 * Local server discovery (browser side) — reads the dev/preview middleware at
 * `/__inspect/servers` (`vite/serverDiscovery.ts`), which scans the local
 * kap-server instance registry and reads the home token. Powers the
 * zero-config startup connect, the header server switcher, and the discovered
 * list on the connect screen. Returns `null` outside dev/preview (no such
 * endpoint on a static host) so the app falls back to the manual flow.
 */

import { useQuery } from '@tanstack/react-query';

export type DiscoveredServerSource = 'instance' | 'lock' | 'proxy';

export interface DiscoveredServer {
  readonly id: string;
  readonly url: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly hostVersion?: string;
  readonly source: DiscoveredServerSource;
}

export interface ServerDiscoveryResult {
  readonly home: string;
  readonly token?: string;
  readonly servers: readonly DiscoveredServer[];
}

export async function fetchServerDiscovery(): Promise<ServerDiscoveryResult | null> {
  let res: Response;
  try {
    res = await fetch('/__inspect/servers');
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const parsed = (await res.json()) as ServerDiscoveryResult;
    return Array.isArray(parsed.servers) ? parsed : null;
  } catch {
    return null;
  }
}

/** Poll discovery: instances come and go (the server-side heartbeat is 15 s). */
export function useServerDiscovery() {
  return useQuery({
    queryKey: ['local-server-discovery'],
    queryFn: fetchServerDiscovery,
    refetchInterval: 10_000,
    retry: false,
    staleTime: 5_000,
  });
}

/** Pick the auto-connect target: the remembered pick when it is still alive,
 * else the dev-proxy target (the standard `pnpm dev:v2` flow), else the
 * longest-running instance. */
export function pickDefaultServer(
  discovery: ServerDiscoveryResult,
  rememberedUrl?: string | null,
): DiscoveredServer | undefined {
  const { servers } = discovery;
  if (servers.length === 0) return undefined;
  if (rememberedUrl !== undefined && rememberedUrl !== null && rememberedUrl !== '') {
    const remembered = servers.find((s) => s.url === rememberedUrl);
    if (remembered !== undefined) return remembered;
  }
  return servers.find((s) => s.source === 'proxy') ?? servers[0];
}
