import { formatHostForUrl, listNetworkAddresses, type NetworkAddress } from './networks';

export function buildOpenableUrl(bareOrigin: string, token: string | undefined): string {
  const base = bareOrigin.endsWith('/') ? bareOrigin.slice(0, -1) : bareOrigin;
  return token === undefined ? `${base}/` : `${base}/#token=${token}`;
}

export function splitTokenFragment(fullUrl: string): [string, string] {
  const marker = '#token=';
  const idx = fullUrl.indexOf(marker);
  return idx < 0 ? [fullUrl, ''] : [fullUrl.slice(0, idx), fullUrl.slice(idx)];
}

export interface AccessUrlLine {
  label: string;
  url: string;
}

function isWildcard(host: string): boolean {
  return host === '' || host === '0.0.0.0' || host === '::';
}

export function browserOpenOrigin(origin: string): string {
  const separator = origin.lastIndexOf(':');
  const host = origin.slice(origin.indexOf('://') + 3, separator);
  if (!isWildcard(host)) return origin;
  return `http://localhost${origin.slice(separator)}`;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function hostOrigin(host: string, port: number): string {
  const family = host.includes(':') ? 'IPv6' : 'IPv4';
  return `http://${formatHostForUrl(host, family)}:${port}`;
}

export function accessUrlLines(
  host: string,
  port: number,
  token: string | undefined,
  networkAddresses?: NetworkAddress[],
): AccessUrlLine[] {
  if (isWildcard(host)) {
    const lines: AccessUrlLine[] = [
      { label: 'Local:    ', url: buildOpenableUrl(`http://localhost:${port}`, token) },
    ];
    const addrs = networkAddresses ?? listNetworkAddresses();
    for (const addr of addrs) {
      lines.push({
        label: 'Network:  ',
        url: buildOpenableUrl(`http://${formatHostForUrl(addr.address, addr.family)}:${port}`, token),
      });
    }
    return lines;
  }
  if (isLoopbackHost(host)) {
    return [{ label: 'Local:    ', url: buildOpenableUrl(hostOrigin(host, port), token) }];
  }
  return [{ label: 'URL:      ', url: buildOpenableUrl(hostOrigin(host, port), token) }];
}
