const KNOWN_SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'com.au',
  'com.br',
  'com.hk',
  'com.tw',
]);

export function domainKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, '');
}

export function rootDomain(raw: string): string {
  const host = domainKey(raw);
  if (host === '' || isIpLiteral(host)) return host;
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (KNOWN_SECOND_LEVEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export function isIpLiteral(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

export function isIPv4(value: string): boolean {
  return parseIPv4(value) !== undefined;
}

export function isIPv6(value: string): boolean {
  const host = value.trim();
  if (!host.includes(':')) return false;
  const zoneless = host.split('%')[0] ?? host;
  if (!/^[0-9a-fA-F:.]+$/.test(zoneless)) return false;
  const parts = zoneless.split('::');
  if (parts.length > 2) return false;
  return (zoneless.match(/:/g)?.length ?? 0) >= 2;
}

function parseIPv4(value: string): number | undefined {
  const host = value.trim();
  const octets = host.split('.');
  if (octets.length !== 4) return undefined;
  let acc = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return undefined;
    const n = Number(octet);
    if (n > 255) return undefined;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

export function ipToHostCidr(ip: string): string {
  const host = ip.trim();
  if (isIPv4(host)) return `${host}/32`;
  if (isIPv6(host)) return `${host}/128`;
  return '';
}

export interface ParsedCidr {
  readonly family: 4 | 6;
  readonly prefix: number;
  readonly base: string;
}

export function parseCidr(value: string): ParsedCidr | undefined {
  const [addr, lenRaw, ...rest] = value.trim().split('/');
  if (addr === undefined || lenRaw === undefined || rest.length > 0) return undefined;
  const prefix = Number(lenRaw);
  if (!Number.isInteger(prefix) || prefix < 0) return undefined;
  if (isIPv4(addr)) {
    if (prefix > 32) return undefined;
    return { family: 4, prefix, base: maskedIPv4(addr, prefix) };
  }
  if (isIPv6(addr)) {
    if (prefix > 128) return undefined;
    return { family: 6, prefix, base: addr.trim().toLowerCase() };
  }
  return undefined;
}

function maskedIPv4(addr: string, prefix: number): string {
  const value = parseIPv4(addr) ?? 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const masked = (value & mask) >>> 0;
  return [masked >>> 24, (masked >>> 16) & 0xff, (masked >>> 8) & 0xff, masked & 0xff].join('.');
}

export function maskedCidr(value: string): string {
  const parsed = parseCidr(value);
  if (parsed === undefined) return value.trim().toLowerCase();
  return `${parsed.base}/${String(parsed.prefix)}`;
}

export function cidrContainsIp(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  if (parsed === undefined) return false;
  if (parsed.family === 4) {
    const value = parseIPv4(ip);
    if (value === undefined) return false;
    const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
    const base = parseIPv4(parsed.base) ?? 0;
    return ((value & mask) >>> 0) === base;
  }
  return isIPv6(ip) && ip.trim().toLowerCase() === parsed.base && parsed.prefix === 128;
}

export function cidrSubsetOf(inner: string, outer: string): boolean {
  const innerCidr = parseCidr(inner) ?? parseCidr(ipToHostCidr(inner));
  const outerCidr = parseCidr(outer) ?? parseCidr(ipToHostCidr(outer));
  if (innerCidr === undefined || outerCidr === undefined) return false;
  if (innerCidr.family !== outerCidr.family) return false;
  if (innerCidr.prefix < outerCidr.prefix) return false;
  if (innerCidr.family === 4) {
    const innerBase = parseIPv4(innerCidr.base) ?? 0;
    const mask = outerCidr.prefix === 0 ? 0 : (0xffffffff << (32 - outerCidr.prefix)) >>> 0;
    const outerBase = parseIPv4(outerCidr.base) ?? 0;
    return ((innerBase & mask) >>> 0) === outerBase;
  }
  return innerCidr.base === outerCidr.base;
}

export function stripHostPort(value: string): string {
  const host = value.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end >= 0) return host.slice(1, end);
    return host;
  }
  if (isIPv6(host)) return host;
  const colon = host.lastIndexOf(':');
  if (colon <= 0) return host;
  const port = host.slice(colon + 1);
  if (/^\d{1,5}$/.test(port)) return host.slice(0, colon);
  return host;
}

export function normalizeIcp(value: string): string {
  return value.replaceAll(/\s+/g, '').toLowerCase();
}
