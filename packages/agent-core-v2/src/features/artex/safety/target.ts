import { isIPv4, isIPv6, maskedCidr, parseCidr, unmapIPv4Mapped } from './net';

export type ArtexTargetKind = 'domain' | 'ip' | 'cidr';

export interface ArtexTarget {
  readonly kind: ArtexTargetKind;
  readonly host: string;
  readonly port: number;
}

const SCHEME_PORTS: Readonly<Record<string, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
};

export function schemeDefaultPort(scheme: string): number {
  return SCHEME_PORTS[scheme.toLowerCase()] ?? 0;
}

export function targetKey(host: string, port: number): string {
  return port > 0 ? `${host}:${String(port)}` : host;
}

export function targetName(target: Pick<ArtexTarget, 'host' | 'port'>): string {
  return targetKey(target.host, target.port);
}

/**
 * Parses one target written as a URL with a scheme, or as a host, host:port,
 * [IPv6]:port, IP literal or CIDR, into normalized form. Ported from ARTEX
 * intercept.NormalizeTarget.
 */
export function normalizeTarget(raw: string): ArtexTarget | undefined {
  let value = raw.trim();
  let defaultPort = 0;
  let isUrl = false;
  const schemeIndex = value.indexOf('://');
  if (schemeIndex > 0) {
    isUrl = true;
    defaultPort = schemeDefaultPort(value.slice(0, schemeIndex));
    value = value.slice(schemeIndex + 3);
    const end = value.search(/[/?#]/);
    if (end >= 0) value = value.slice(0, end);
    const at = value.lastIndexOf('@');
    if (at >= 0) value = value.slice(at + 1);
  }
  let host = value;
  let port = '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return undefined;
    host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest !== '') {
      if (rest[0] !== ':') return undefined;
      port = rest.slice(1);
    }
  } else if ((value.match(/:/g)?.length ?? 0) === 1) {
    const colon = value.indexOf(':');
    host = value.slice(0, colon);
    port = value.slice(colon + 1);
  }
  if (isUrl && !value.startsWith('[')) {
    try {
      host = decodeURIComponent(host);
    } catch {
      // keep the raw host when it is not valid percent-encoding
    }
  }
  let resolvedPort = defaultPort;
  if (port !== '') {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return undefined;
    resolvedPort = parsed;
  }
  const normalized = normalizeHost(host, true);
  if (normalized === undefined) return undefined;
  return { kind: normalized.kind, host: normalized.host, port: resolvedPort };
}

export interface NormalizedHost {
  readonly kind: ArtexTargetKind;
  readonly host: string;
}

/**
 * Returns the kind and canonical form of a host. numeric accepts the
 * non-dotted IPv4 forms (decimal, hex, octal, short) that a URL host may use.
 * Ported from ARTEX intercept.normalizeHost.
 */
export function normalizeHost(raw: string, numeric: boolean): NormalizedHost | undefined {
  let host = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (host === '') return undefined;
  if (host.includes('/')) {
    const cidr = parseCidr(host);
    if (cidr === undefined) return undefined;
    return { kind: 'cidr', host: maskedCidr(host) };
  }
  const unmapped = unmapIPv4Mapped(host);
  if (isIPv4(unmapped)) return { kind: 'ip', host: unmapped };
  if (isIPv6(unmapped)) {
    return { kind: 'ip', host: canonicalIPv6(unmapped) };
  }
  if (numeric) {
    const addr = parseIPv4Forms(host);
    if (addr !== undefined) return { kind: 'ip', host: addr };
  }
  const ascii = toAsciiHost(host);
  if (ascii !== undefined && ascii !== '') host = ascii;
  return { kind: 'domain', host };
}

function canonicalIPv6(host: string): string {
  const zone = host.indexOf('%');
  const base = zone >= 0 ? host.slice(0, zone) : host;
  return base.toLowerCase();
}

function toAsciiHost(host: string): string | undefined {
  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname;
    return hostname === '' ? undefined : hostname;
  } catch {
    return undefined;
  }
}

/**
 * Reads an IPv4 address the way inet_aton does: one to four parts, each decimal,
 * hex (0x) or octal (leading 0), the last filling the remaining bytes. Ported
 * from ARTEX intercept.parseIPv4Forms.
 */
export function parseIPv4Forms(raw: string): string | undefined {
  const parts = raw.split('.');
  if (parts.length === 0 || parts.length > 4) return undefined;
  let value = 0n;
  for (let n = 0; n < parts.length; n += 1) {
    let part = parts[n] ?? '';
    let base = 10;
    if (part.startsWith('0x') || part.startsWith('0X')) {
      part = part.slice(2);
      base = 16;
    } else if (part.length > 1 && part.startsWith('0')) {
      part = part.slice(1);
      base = 8;
    }
    if (part === '' || !isRadixDigits(part, base)) return undefined;
    const x = BigInt(parseInt(part, base));
    if (Number.isNaN(Number(x))) return undefined;
    if (n < parts.length - 1) {
      if (x > 255n) return undefined;
      value = (value << 8n) | x;
    } else {
      const rest = BigInt(8 * (4 - n));
      if (x >= 1n << rest) return undefined;
      value = (value << rest) | x;
    }
  }
  const b0 = Number((value >> 24n) & 0xffn);
  const b1 = Number((value >> 16n) & 0xffn);
  const b2 = Number((value >> 8n) & 0xffn);
  const b3 = Number(value & 0xffn);
  return `${String(b0)}.${String(b1)}.${String(b2)}.${String(b3)}`;
}

function isRadixDigits(value: string, base: number): boolean {
  if (base === 16) return /^[0-9a-fA-F]+$/.test(value);
  if (base === 8) return /^[0-7]+$/.test(value);
  return /^[0-9]+$/.test(value);
}

/**
 * Reports whether host is a plain DNS name: labels of letters, digits, hyphen
 * and underscore. Ported from ARTEX intercept.validHostname.
 */
export function validHostname(host: string): boolean {
  if (host.length > 253) return false;
  for (const label of host.split('.')) {
    if (label === '' || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    if (!/^[a-z0-9_-]+$/i.test(label)) return false;
  }
  return true;
}
