import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export interface NetworkAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
}

export function listNetworkAddresses(): NetworkAddress[] {
  let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  try {
    interfaces = networkInterfaces();
  } catch {
    return [];
  }
  const raw: NetworkAddress[] = [];
  for (const entries of Object.values(interfaces)) {
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

function isLinkLocalV6(address: string): boolean {
  const first = Number.parseInt(address.split(':')[0] ?? '', 16);
  return first >= 0xfe80 && first <= 0xfebf;
}

export function formatHostForUrl(address: string, family: NetworkAddress['family']): string {
  return family === 'IPv6' ? `[${address}]` : address;
}
