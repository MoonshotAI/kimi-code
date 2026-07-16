import { lookup as callbackLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';
import { Agent, type Dispatcher } from 'undici';

import { isProxyConfigured } from '#/_base/utils/proxy';

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../tools/fetch-url-types';

type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

interface DomElementLike {
  textContent: string | null;
  querySelector(selector: string): DomElementLike | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const MAX_REDIRECT_HOPS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface LocalFetchURLProviderOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  allowPrivateAddresses?: boolean;
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  async fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult> {
    // Pinned Agents are created per redirect hop and closed once the final
    // body is consumed, so keep-alive sockets never linger.
    const dispatchers: Dispatcher[] = [];
    try {
      const response = await this.requestWithValidatedRedirects(
        url,
        options?.signal,
        dispatchers,
      );
      return await this.readResponse(response);
    } finally {
      await Promise.all(
        dispatchers.map((dispatcher) =>
          dispatcher.close().catch(() => {
          }),
        ),
      );
    }
  }

  private async readResponse(response: Response): Promise<UrlFetchResult> {
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => {
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const body = await response.text();

    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }

    return { content: this.extractMainContent(body), kind: 'extracted' };
  }

  /**
   * GET `url`, following redirects manually. Every hop re-runs the full
   * SSRF check (IP-literal + DNS) before the request goes out — a public
   * URL must not be able to bounce the fetcher at an internal address.
   * Redirects without a `Location` header are treated as final responses.
   */
  private async requestWithValidatedRedirects(
    url: string,
    signal: AbortSignal | undefined,
    dispatchers: Dispatcher[],
  ): Promise<Response> {
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      const target = await resolveSafeFetchTarget(currentUrl, this.allowPrivateAddresses);
      const response = await this.fetchImpl(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal,
        redirect: 'manual',
        // `dispatcher` is honored by undici at runtime but absent from
        // DOM's RequestInit type (DOM-lib consumers typecheck this source)
        // — hide it behind `unknown` to stay lib-agnostic.
        dispatcher: this.pinnedDispatcherFor(target, dispatchers) as unknown,
      } as RequestInit);
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      await response.body?.cancel().catch(() => {
      });
      if (redirects >= MAX_REDIRECT_HOPS) {
        throw new Error(
          `Too many redirects while fetching "${url}" (limit ${String(MAX_REDIRECT_HOPS)}).`,
        );
      }
      redirects += 1;
      currentUrl = new URL(location, currentUrl).toString();
    }
  }

  /**
   * Pin the connection to the addresses the safety check just validated.
   * undici resolves the origin again when it connects, so without pinning
   * an attacker-controlled DNS could answer the check with a public IP and
   * the connect with an internal one (TOCTOU / DNS rebinding).
   */
  private pinnedDispatcherFor(
    target: SafeFetchTarget,
    dispatchers: Dispatcher[],
  ): Dispatcher | undefined {
    // IP literals (and allowPrivate mode) need no pin — there is no second
    // resolution to race.
    if (target.addresses === undefined) return undefined;
    // With an HTTP/SOCKS proxy configured, origin resolution happens on the
    // proxy side; a direct-connect pinned Agent would bypass the proxy
    // entirely, so pinning only applies to direct connections.
    if (isProxyConfigured(process.env)) return undefined;
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup(target.host, target.addresses) },
    });
    dispatchers.push(dispatcher);
    return dispatcher;
  }

  private extractMainContent(html: string): string {
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {
    }

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error(
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}

// SSRF blocklist: loopback / RFC 1918 / link-local / CGNAT / ULA and "this
// network", for both address families. BlockList.check() maps IPv4-mapped
// IPv6 addresses (e.g. ::ffff:127.0.0.1) onto the IPv4 subnets, so mapped
// literals cannot slip past the v4 rules.
const PRIVATE_ADDRESS_BLOCKLIST = (() => {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
  list.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
  list.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local / cloud metadata
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('::', 128, 'ipv6'); // unspecified
  list.addSubnet('::1', 128, 'ipv6'); // loopback
  list.addSubnet('fc00::', 7, 'ipv6'); // ULA
  list.addSubnet('fe80::', 10, 'ipv6'); // link-local
  return list;
})();

function isBlockedAddress(address: string): boolean {
  // Link-local addresses may carry a zone id ("fe80::1%en0") — strip it
  // before matching.
  const normalized = address.split('%', 1)[0] ?? address;
  if (isIP(normalized) === 4) return PRIVATE_ADDRESS_BLOCKLIST.check(normalized, 'ipv4');
  return isIP(normalized) === 6 && PRIVATE_ADDRESS_BLOCKLIST.check(normalized, 'ipv6');
}

interface SafeFetchTarget {
  /** Lowercased hostname with any IPv6 brackets stripped. */
  host: string;
  /** Validated DNS answers to pin the connection to — absent when no lookup was needed. */
  addresses?: LookupAddress[];
}

async function resolveSafeFetchTarget(url: string, allowPrivate: boolean): Promise<SafeFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`);
  }
  // URL hostname preserves surrounding `[ ]` for IPv6 literals on some
  // Node versions (and not others). Strip them for uniform comparison.
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  if (allowPrivate) return { host };
  // IP literals are checked directly and never resolved.
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
    return { host };
  }
  // Literal "localhost" / loopback aliases.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // Hostnames must be resolved and every resulting address checked — a
  // public-looking domain can point at loopback (e.g. localtest.me) or any
  // internal address. The validated answers are returned so the caller can
  // pin the connection to them (TOCTOU / DNS-rebinding protection).
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resolve host "${host}" for the fetch safety check: ${detail}`, {
      cause: error,
    });
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Refusing to fetch host "${host}": resolves to private address "${address}".`);
    }
  }
  return { host, addresses };
}

/**
 * Build a `net`/`tls` lookup hook that answers `host` from the validated
 * address set, so the connect-time resolution cannot drift from what the
 * safety check approved. Anything else is delegated to the real resolver
 * (a per-hop Agent only ever connects to its own origin, but stay
 * functional if reused elsewhere).
 */
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
