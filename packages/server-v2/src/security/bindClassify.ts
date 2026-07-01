/**
 * Bind-address classification for server exposure hardening.
 */

import { isIP } from 'node:net';

export type BindClass = 'loopback' | 'lan' | 'public';

export interface ClassifyOptions {
  readonly bindClass?: 'lan' | 'public';
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.');
  return (
    (((Number(a) << 24) >>> 0) +
      ((Number(b) << 16) >>> 0) +
      ((Number(c) << 8) >>> 0) +
      (Number(d) >>> 0)) >>>
    0
  );
}

function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

function expandV6(host: string): readonly string[] | null {
  const lower = host.toLowerCase();
  if (lower.includes('::')) {
    const halves = lower.split('::');
    const leftRaw = halves[0] ?? '';
    const rightRaw = halves[1] ?? '';
    const left = leftRaw.length > 0 ? leftRaw.split(':') : [];
    const right = rightRaw.length > 0 ? rightRaw.split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    return [...left, ...Array<string>(missing).fill('0'), ...right];
  }
  const parts = lower.split(':');
  return parts.length === 8 ? parts : null;
}

function isLinkLocalV6(host: string): boolean {
  const groups = expandV6(host);
  if (groups === null) return false;
  const first = Number.parseInt(groups[0] ?? '', 16);
  return first >= 0xfe80 && first <= 0xfebf;
}

export function classify(host: string, opts?: ClassifyOptions): BindClass {
  if (host === '' || host === '0.0.0.0' || host === '::') {
    return opts?.bindClass ?? 'public';
  }
  if (host === 'localhost') {
    return 'loopback';
  }
  const family = isIP(host);
  if (family === 4) {
    if (host.startsWith('127.')) return 'loopback';
    if (ipv4InCidr(host, '10.0.0.0', 8)) return 'lan';
    if (ipv4InCidr(host, '172.16.0.0', 12)) return 'lan';
    if (ipv4InCidr(host, '192.168.0.0', 16)) return 'lan';
    if (ipv4InCidr(host, '169.254.0.0', 16)) return 'lan';
    return 'public';
  }
  if (family === 6) {
    if (host.toLowerCase() === '::1') return 'loopback';
    if (isLinkLocalV6(host)) return 'lan';
    return 'public';
  }
  return 'public';
}
