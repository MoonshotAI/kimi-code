import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4, isIPv6 } from 'node:net';

import { oneLine } from './render';
import { ALLOW_LOCAL_TARGETS_ENV, type NotifyDnsLookup, type NotifyTransportOptions } from './types';

export function isPrivateTargetAllowed(options?: NotifyTransportOptions): boolean {
  if (options?.allowPrivateTargets !== undefined) {
    return options.allowPrivateTargets;
  }
  const env = (process.env[ALLOW_LOCAL_TARGETS_ENV] ?? '').trim().toLowerCase();
  return env === '1' || env === 'true';
}

export function stripIpBrackets(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | undefined {
  if (!isIPv4(ip)) return undefined;
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4Octets(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / this network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

function parseIpv6Hextets(raw: string): number[] | undefined {
  const zoneless = raw.split('%')[0] ?? raw;
  if (!isIPv6(zoneless)) return undefined;
  const dblIdx = zoneless.indexOf('::');
  let leftParts: string[];
  let rightParts: string[];
  if (dblIdx >= 0) {
    const left = zoneless.slice(0, dblIdx);
    const right = zoneless.slice(dblIdx + 2);
    leftParts = left === '' ? [] : left.split(':');
    rightParts = right === '' ? [] : right.split(':');
  } else {
    leftParts = zoneless.split(':');
    rightParts = [];
  }

  const expandPart = (parts: readonly string[]): number[] | undefined => {
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (part.includes('.')) {
        if (i !== parts.length - 1) return undefined;
        const v4 = parseIpv4Octets(part);
        if (v4 === undefined) return undefined;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };

  const leftNums = expandPart(leftParts);
  const rightNums = expandPart(rightParts);
  if (leftNums === undefined || rightNums === undefined) return undefined;

  if (dblIdx < 0) {
    return leftNums.length === 8 ? leftNums : undefined;
  }
  const missing = 8 - (leftNums.length + rightNums.length);
  if (missing < 1) return undefined;
  return [...leftNums, ...Array.from({ length: missing }, () => 0), ...rightNums];
}

export function isBlockedNotifyIp(rawIp: string): boolean {
  const ip = stripIpBrackets(rawIp);
  if (ip === '') return true;

  const v4 = parseIpv4Octets(ip);
  if (v4 !== undefined) {
    return isBlockedIpv4Octets(v4);
  }

  const hextets = parseIpv6Hextets(ip);
  if (hextets === undefined) return true;

  const isAllZeroPrefix = (count: number): boolean => {
    for (let i = 0; i < count; i += 1) {
      if (hextets[i] !== 0) return false;
    }
    return true;
  };

  // Unspecified ::
  if (isAllZeroPrefix(8)) return true;
  // Loopback ::1
  if (isAllZeroPrefix(7) && hextets[7] === 1) return true;
  // IPv4-mapped ::ffff:0:0/96 (both dotted and hex forms)
  if (isAllZeroPrefix(5) && hextets[5] === 0xffff) {
    const mapped: [number, number, number, number] = [
      (hextets[6]! >>> 8) & 0xff,
      hextets[6]! & 0xff,
      (hextets[7]! >>> 8) & 0xff,
      hextets[7]! & 0xff,
    ];
    return isBlockedIpv4Octets(mapped);
  }
  // IPv4-compatible ::/96
  if (isAllZeroPrefix(6)) {
    const compat: [number, number, number, number] = [
      (hextets[6]! >>> 8) & 0xff,
      hextets[6]! & 0xff,
      (hextets[7]! >>> 8) & 0xff,
      hextets[7]! & 0xff,
    ];
    return isBlockedIpv4Octets(compat);
  }
  // ULA fc00::/7
  if ((hextets[0]! & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((hextets[0]! & 0xff00) === 0xff00) return true;

  return false;
}

export function redactRequestTarget(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.host === '') return '(unparseable address)';
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return '(unparseable address)';
  }
}

export function redactUrlsInText(text: string): string {
  return text.replaceAll(/https?:\/\/[^\s"'<>]+/gi, (match) => redactRequestTarget(match));
}

export function redactTransportError(op: string, rawUrl: string, err: unknown): string {
  let host = '';
  try {
    host = new URL(rawUrl).host;
  } catch {
    host = '';
  }
  const msg = err instanceof Error ? err.message : String(err);
  const redactedMsg = redactUrlsInText(msg);
  if (host === '') return `${op}: ${redactedMsg}`;
  return `${op} ${host}: ${redactedMsg}`;
}

export function snippet(raw: string | Buffer): string {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return oneLine(text, 200);
}

export function validateHttpUrl(raw: string, options?: NotifyTransportOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`address cannot be parsed (${redactRequestTarget(raw)})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http/https are supported, got "${parsed.protocol.replace(/:$/, '')}"`);
  }
  if (parsed.host === '' || parsed.hostname === '') {
    throw new Error('missing host name');
  }
  const host = stripIpBrackets(parsed.hostname);
  if (!isPrivateTargetAllowed(options)) {
    if (isIP(host) !== 0 && isBlockedNotifyIp(host)) {
      throw new Error(
        `refusing to deliver to private/loopback/link-local address ${host} (if you really need to deliver to a local service, set ${ALLOW_LOCAL_TARGETS_ENV}=1)`,
      );
    }
    const lowerHost = host.toLowerCase();
    if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost')) {
      throw new Error(
        `refusing to deliver to loopback host ${host} (if you really need to deliver to a local service, set ${ALLOW_LOCAL_TARGETS_ENV}=1)`,
      );
    }
  }
  return parsed;
}

export type SafeDnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | readonly { readonly address: string; readonly family: number }[],
  family?: number,
) => void;

export function createSafeLookup(options?: NotifyTransportOptions) {
  const resolver: NotifyDnsLookup =
    options?.dnsLookup ??
    (async (hostname: string) => {
      const records = await dnsLookup(hostname, { all: true });
      return records.map((r) => ({
        address: r.address,
        family: r.family === 6 ? 6 : 4,
      }));
    });

  const resolveRecords = async (
    cleanHost: string,
  ): Promise<
    | { readonly ok: true; readonly records: readonly { readonly address: string; readonly family: 4 | 6 }[] }
    | { readonly ok: false; readonly error: NodeJS.ErrnoException }
  > => {
    try {
      const records = await resolver(cleanHost);
      if (records.length === 0) {
        return {
          ok: false,
          error: new Error(`DNS lookup returned no addresses for ${cleanHost}`) as NodeJS.ErrnoException,
        };
      }
      if (!isPrivateTargetAllowed(options)) {
        for (const rec of records) {
          if (isBlockedNotifyIp(rec.address)) {
            return {
              ok: false,
              error: new Error(
                `refusing to deliver to private/loopback/link-local address ${rec.address} (if you really need to deliver to a local service, set ${ALLOW_LOCAL_TARGETS_ENV}=1)`,
              ) as NodeJS.ErrnoException,
            };
          }
        }
      }
      return { ok: true, records };
    } catch (error) {
      return {
        ok: false,
        error: (error instanceof Error ? error : new Error(String(error))) as NodeJS.ErrnoException,
      };
    }
  };

  return (hostname: string, lookupOpts: unknown, callback: SafeDnsLookupCallback): void => {
    const cleanHost = stripIpBrackets(hostname);
    const wantAll =
      typeof lookupOpts === 'object' &&
      lookupOpts !== null &&
      'all' in lookupOpts &&
      (lookupOpts as { all?: boolean }).all === true;

    const emitResult = (
      records: readonly { readonly address: string; readonly family: 4 | 6 }[],
    ): void => {
      if (wantAll) {
        callback(
          null,
          records.map((r) => ({ address: r.address, family: r.family })),
        );
      } else {
        const first = records[0]!;
        callback(null, first.address, first.family);
      }
    };

    if (isIP(cleanHost) !== 0) {
      const family: 4 | 6 = isIPv4(cleanHost) ? 4 : 6;
      const records = [{ address: cleanHost, family }];
      if (!isPrivateTargetAllowed(options) && isBlockedNotifyIp(cleanHost)) {
        callback(
          new Error(
            `refusing to deliver to private/loopback/link-local address ${cleanHost} (if you really need to deliver to a local service, set ${ALLOW_LOCAL_TARGETS_ENV}=1)`,
          ) as NodeJS.ErrnoException,
          '',
        );
        return;
      }
      emitResult(records);
      return;
    }

    void (async () => {
      const result = await resolveRecords(cleanHost);
      if (!result.ok) {
        callback(result.error, '');
        return;
      }
      emitResult(result.records);
    })();
  };
}
