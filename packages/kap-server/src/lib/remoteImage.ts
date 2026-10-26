import { lookup as callbackLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { isProxyConfigured, makeNoProxyMatcher, resolveNoProxy } from '@moonshot-ai/agent-core-v2/_base/utils/proxy';
import { Agent, type Dispatcher } from 'undici';

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REMOTE_IMAGE_REDIRECTS = 3;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_ADDRESSES = (() => {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('224.0.0.0', 4, 'ipv4');
  list.addSubnet('240.0.0.0', 4, 'ipv4');
  list.addSubnet('::', 128, 'ipv6');
  list.addSubnet('::1', 128, 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('ff00::', 8, 'ipv6');
  return list;
})();

export type RemoteImageErrorKind = 'invalid' | 'too_large' | 'upstream';

export class RemoteImageError extends Error {
  constructor(
    readonly kind: RemoteImageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteImageError';
  }
}

export interface RemoteImagePayload {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly extension: string;
}

interface RemoteImageTarget {
  readonly host: string;
  readonly port: string;
  readonly addresses?: LookupAddress[];
}

type RemoteImageLookup = (host: string, options: { all: true }) => Promise<LookupAddress[]>;

export interface RemoteImageOptions {
  readonly fetchImpl?: typeof fetch;
  readonly lookupImpl?: RemoteImageLookup;
  readonly timeoutMs?: number;
}

export async function fetchRemoteImage(input: string, options: RemoteImageOptions = {}): Promise<RemoteImagePayload> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const lookupImpl = options.lookupImpl ?? lookup;
  const deadline = Date.now() + (options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);
  const signal = AbortSignal.timeout(options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);
  const dispatchers: Dispatcher[] = [];
  try {
    let current = input;
    for (let redirects = 0; ; redirects++) {
      const target = await resolveRemoteImageTarget(current, lookupImpl, deadline);
      const response = await fetchImpl(target.url, {
        headers: { accept: 'image/avif,image/png,image/jpeg,image/gif,image/webp' },
        redirect: 'manual',
        signal,
        dispatcher: pinnedDispatcherFor(target, dispatchers) as unknown,
      } as RequestInit).catch((error: unknown) => {
        throw new RemoteImageError('upstream', `Remote image request failed: ${errorMessage(error)}`);
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (location === null) {
          throw new RemoteImageError('upstream', `Remote image returned HTTP ${response.status} without Location`);
        }
        if (redirects >= MAX_REMOTE_IMAGE_REDIRECTS) {
          throw new RemoteImageError('upstream', 'Remote image exceeded the redirect limit');
        }
        current = new URL(location, target.url).toString();
        continue;
      }
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new RemoteImageError('upstream', `Remote image returned HTTP ${response.status}`);
      }
      const bytes = await readImageBody(response);
      return { bytes, ...detectImageType(bytes) };
    }
  } finally {
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.close().catch(() => undefined)));
  }
}

async function resolveRemoteImageTarget(
  input: string,
  lookupImpl: RemoteImageLookup,
  deadline: number,
): Promise<RemoteImageTarget & { url: string }> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new RemoteImageError('invalid', 'Remote image URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RemoteImageError('invalid', 'Remote image URL must use HTTP or HTTPS');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RemoteImageError('invalid', 'Remote image URL must not contain credentials');
  }
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new RemoteImageError('invalid', 'Remote image target is not allowed');
    return { url: parsed.toString(), host, port };
  }
  const normalizedHost = host.endsWith('.') ? host.slice(0, -1) : host;
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) {
    throw new RemoteImageError('invalid', 'Remote image target is not allowed');
  }
  let addresses: LookupAddress[];
  try {
    addresses = await withRemoteImageDeadline(lookupImpl(host, { all: true }), deadline);
  } catch (error) {
    if (error instanceof RemoteImageError) throw error;
    throw new RemoteImageError('invalid', `Remote image host cannot be resolved: ${errorMessage(error)}`);
  }
  if (addresses.length === 0) throw new RemoteImageError('invalid', 'Remote image host cannot be resolved');
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new RemoteImageError('invalid', 'Remote image target is not allowed');
  }
  return { url: parsed.toString(), host, port, addresses };
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.split('%', 1)[0] ?? address;
  if (isIP(normalized) === 4) return BLOCKED_ADDRESSES.check(normalized, 'ipv4');
  if (isIP(normalized) !== 6) return false;
  if (normalized.toLowerCase().startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isBlockedAddress(mapped);
  }
  return BLOCKED_ADDRESSES.check(normalized, 'ipv6');
}

function pinnedDispatcherFor(target: RemoteImageTarget, dispatchers: Dispatcher[]): Dispatcher | undefined {
  if (target.addresses === undefined) return undefined;
  if (isProxyConfigured(process.env) && !makeNoProxyMatcher(resolveNoProxy(process.env))(target.host, target.port)) {
    return undefined;
  }
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(target.host, target.addresses) },
  });
  dispatchers.push(dispatcher);
  return dispatcher;
}

async function withRemoteImageDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new RemoteImageError('upstream', 'Remote image request timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RemoteImageError('upstream', 'Remote image request timed out'));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function pinnedLookup(host: string, addresses: LookupAddress[]): LookupFunction {
  return (hostname: string, options: LookupOptions | undefined, callback: PinnedLookupCallback) => {
    if (hostname !== host) {
      callbackLookup(hostname, options ?? {}, callback);
      return;
    }
    if (options?.all === true) {
      callback(null, [...addresses]);
      return;
    }
    const single = addresses.find((entry) => entry.family === options?.family) ?? addresses[0]!;
    callback(null, single.address, single.family);
  };
}

type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrList: string | LookupAddress[],
  family?: number,
) => void;

async function readImageBody(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new RemoteImageError('too_large', 'Remote image exceeds the 10 MiB limit');
  }
  if (response.body === null) throw new RemoteImageError('upstream', 'Remote image response is empty');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_REMOTE_IMAGE_BYTES) {
        throw new RemoteImageError('too_large', 'Remote image exceeds the 10 MiB limit');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RemoteImageError) throw error;
    throw new RemoteImageError('upstream', `Remote image download failed: ${errorMessage(error)}`);
  }
  if (size === 0) throw new RemoteImageError('upstream', 'Remote image response is empty');
  return Buffer.concat(chunks, size);
}

function detectImageType(bytes: Buffer): { mimeType: string; extension: string } {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  const prefix = bytes.subarray(0, 12).toString('ascii');
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return { mimeType: 'image/avif', extension: '.avif' };
  }
  throw new RemoteImageError('invalid', 'Remote response is not a supported raster image');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
