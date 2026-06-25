/**
 * Enumerate this machine's non-loopback network interface addresses, used to
 * print `Network: http://<addr>:<port>/` hints (à la Vite) when the server
 * binds a wildcard host (`0.0.0.0` / `::`).
 */

import { networkInterfaces } from 'node:os';

export interface NetworkAddress {
  /** Raw IP address (IPv4 or IPv6); IPv6 is NOT bracket-wrapped here. */
  address: string;
  family: 'IPv4' | 'IPv6';
}

/**
 * List non-internal interface addresses, IPv4 first then IPv6, preserving
 * interface order within each family.
 *
 * Like Vite, this lists the machine's own interface addresses — LAN
 * (192.168/10/172.16) plus any directly-assigned public address. It does not
 * (and cannot, without an external service) discover a NAT-translated WAN IP,
 * and we deliberately avoid any network call for a startup hint.
 */
export function listNetworkAddresses(): NetworkAddress[] {
  const raw: NetworkAddress[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.internal) {
        continue;
      }
      if (info.family === 'IPv4') {
        raw.push({ address: info.address, family: 'IPv4' });
      } else if (info.family === 'IPv6') {
        raw.push({ address: info.address, family: 'IPv6' });
      }
    }
  }
  return filterDisplayAddresses(raw);
}

/**
 * Drop addresses that are not useful as a connect target and de-duplicate.
 *
 * IPv6 link-local (`fe80::/10`) is filtered out: it is only reachable with a
 * zone id (e.g. `fe80::1%en0`), which our bare URL cannot carry, so showing it
 * is pure noise — and it is the bulk of what `os.networkInterfaces()` reports
 * on a typical machine. Duplicates (the same address reported on more than one
 * interface) are collapsed. The result is IPv4 first, then IPv6, preserving
 * order within each family.
 */
export function filterDisplayAddresses(
  addrs: readonly NetworkAddress[],
): NetworkAddress[] {
  const seen = new Set<string>();
  const kept: NetworkAddress[] = [];
  for (const addr of addrs) {
    if (addr.family === 'IPv6' && isLinkLocalV6(addr.address)) {
      continue;
    }
    if (seen.has(addr.address)) {
      continue;
    }
    seen.add(addr.address);
    kept.push(addr);
  }
  return [
    ...kept.filter((a) => a.family === 'IPv4'),
    ...kept.filter((a) => a.family === 'IPv6'),
  ];
}

/** True for IPv6 link-local addresses (`fe80::/10`, i.e. `fe80::`–`febf::`). */
function isLinkLocalV6(address: string): boolean {
  const first = Number.parseInt(address.split(':')[0] ?? '', 16);
  return first >= 0xfe80 && first <= 0xfebf;
}

/**
 * Format an address for use as a URL host: bracket-wrap IPv6 per RFC 3986,
 * return IPv4 as-is.
 */
export function formatHostForUrl(address: string, family: NetworkAddress['family']): string {
  return family === 'IPv6' ? `[${address}]` : address;
}
