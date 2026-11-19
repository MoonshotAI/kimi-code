import type { AppHost } from '../api/types';

export type HostDisplayState = 'local' | 'missing' | 'disabled' | 'ready' | 'connecting' | 'failed' | 'idle';

export function hostDisplayState(
  hostId: string | undefined,
  host: AppHost | undefined,
  options: { loaded: boolean; connecting?: boolean },
): HostDisplayState {
  if (hostId === undefined) return 'local';
  if (host === undefined) return options.loaded ? 'missing' : 'idle';
  if (host.enabled === false) return 'disabled';
  if (host.status === 'ready') return 'ready';
  if (host.status === 'connecting' || options.connecting === true) return 'connecting';
  if (host.status === 'disconnected' && host.connectError !== undefined) return 'failed';
  return 'idle';
}

export function isHostBlocked(state: HostDisplayState): boolean {
  return state === 'disabled' || state === 'missing' || state === 'failed';
}

export function hostDisplayName(host: Pick<AppHost, 'id' | 'name'>): string {
  return host.name ?? host.id;
}
