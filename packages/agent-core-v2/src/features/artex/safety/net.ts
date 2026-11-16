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

export function unmapIPv4Mapped(ip: string): string {
  const lower = ip.trim().toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (isIPv4(mapped)) return mapped;
  }
  return ip;
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
  const v6 = expandIPv6(addr);
  if (v6 === undefined) return undefined;
  if (prefix > 128) return undefined;
  return { family: 6, prefix, base: maskedIPv6(v6, prefix) };
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
  const normalizedIp = unmapIPv4Mapped(ip);
  if (parsed.family === 4) {
    const value = parseIPv4(normalizedIp);
    if (value === undefined) return false;
    const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
    const base = parseIPv4(parsed.base) ?? 0;
    return ((value & mask) >>> 0) === base;
  }
  const addr = expandIPv6(normalizedIp);
  const base = expandIPv6(parsed.base);
  if (addr === undefined || base === undefined) return false;
  return sameIpv6Prefix(addr, base, parsed.prefix);
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
  if (innerCidr.family === 6) {
    const inner = expandIPv6(innerCidr.base);
    const outer = expandIPv6(outerCidr.base);
    if (inner === undefined || outer === undefined) return false;
    return sameIpv6Prefix(inner, outer, outerCidr.prefix);
  }
  return innerCidr.base === outerCidr.base;
}

function expandIPv6(ip: string): string | undefined {
  if (!isIPv6(ip)) return undefined;
  const zoneless = unmapIPv4Mapped(ip.trim().toLowerCase()).split('%')[0] ?? '';
  if (zoneless === '::') return '0000:0000:0000:0000:0000:0000:0000:0000';
  const parts = zoneless.split('::');
  if (parts.length > 2) return undefined;
  const head = (parts[0] ?? '').split(':').filter((segment) => segment.length > 0);
  const tail = (parts[1] ?? '').split(':').filter((segment) => segment.length > 0);
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return undefined;
  const zeroFill = Array.from({ length: missing }, () => '0000');
  return [...head, ...zeroFill, ...tail]
    .map((segment) => segment.padStart(4, '0').slice(-4))
    .join(':');
}

function ipv6ToBigInt(expanded: string): bigint {
  return expanded.split(':').reduce((acc, part) => (acc << 16n) + BigInt(Number.parseInt(part, 16)), 0n);
}

function maskedIPv6(expanded: string, prefix: number): string {
  const value = ipv6ToBigInt(expanded);
  const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) << BigInt(128 - prefix);
  const masked = value & mask;
  const segments: string[] = [];
  for (let i = 7; i >= 0; i -= 1) {
    const shift = BigInt(i * 16);
    segments.push(((masked >> shift) & 0xffffn).toString(16).padStart(4, '0'));
  }
  return segments.join(':');
}

function sameIpv6Prefix(ip: string, base: string, prefix: number): boolean {
  const ipValue = ipv6ToBigInt(ip);
  const baseValue = ipv6ToBigInt(base);
  const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) << BigInt(128 - prefix);
  return (ipValue & mask) === (baseValue & mask);
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
