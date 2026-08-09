/**
 * LocalFetchURLProvider — host-side URL fetcher.
 *
 * Flow:
 *   1. Validate the URL against the SSRF rules (scheme, IP literals, DNS
 *      resolution) and GET it with a Chrome-like UA, following redirects
 *      manually with every hop re-validated and pinned to the validated
 *      addresses.
 *   2. Reject HTTP >= 400 with the status code in the message.
 *   3. Reject responses larger than `maxBytes` (content-length first,
 *      then measured body length as a defensive second check).
 *   4. `text/plain` / `text/markdown` → passthrough verbatim.
 *   5. Otherwise (assumed HTML) → run Readability over a linkedom
 *      document. Return `# ${title}\n\n${text}` (title omitted when
 *      absent). If extraction yields no meaningful text, fall back to
 *      common content containers (`<article>` / `<main>` / `<body>`)
 *      before throwing a "meaningful content" error.
 */

import { lookup as callbackLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';
import { Agent, type Dispatcher } from 'undici';

import { isProxyConfigured, makeNoProxyMatcher, resolveNoProxy } from '../../utils/proxy';
import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';

// Readability's .d.ts references the global `Document` type, but this
// package compiles with `lib: ES2023` (no DOM). Extracting the
// constructor parameter type keeps us off the global `Document` name
// while still accepting whatever Readability wants.
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// linkedom's published types depend on DOM libs we don't load. Declare
// the minimal surface we actually use so the rest of the file stays
// type-safe without pulling lib.dom.d.ts into the host build.
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
  /**
   * Allow fetching loopback / RFC 1918 / link-local / ULA addresses.
   * Defaults to `false` — enabled only for tests and (future) explicit
   * opt-in. Keeps an LLM that's been prompt-injected from exfiltrating
   * AWS/GCP metadata (169.254.169.254), probing internal services
   * (10.x, 192.168.x), or reading local daemons (127.0.0.1:*).
   */
  allowPrivateAddresses?: boolean;
}

/**
 * SSRF blocklist: loopback / RFC 1918 / link-local / CGNAT / ULA and
 * "this network", for both address families. BlockList.check() maps
 * IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) onto the IPv4
 * subnets, so mapped literals cannot slip past the v4 rules.
 */
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
  /** Effective origin port — explicit, or the scheme default. */
  port: string;
  /** Validated DNS answers to pin the connection to — absent when no lookup was needed. */
  addresses?: LookupAddress[];
}

/**
 * SSRF guard — reject non-http(s) schemes and (by default) anything that
 * resolves to a private / loopback / link-local / ULA address: IP literals
 * are checked directly, hostnames are resolved via DNS and every resulting
 * address is checked. Re-run for every redirect hop by the caller. Returns
 * the validated DNS answers so the connection can be pinned to them —
 * otherwise the connect-time re-resolution could be answered differently
 * (TOCTOU / DNS rebinding).
 */
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
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  if (allowPrivate) return { host, port };
  // IP literals are checked directly and never resolved.
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
    return { host, port };
  }
  // Literal "localhost" / loopback aliases.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // Hostnames must be resolved and every resulting address checked — a
  // public-looking domain can point at loopback (e.g. localtest.me) or any
  // internal address.
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
  return { host, port, addresses };
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

  async fetch(url: string, _options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    // Pinned Agents are created per redirect hop and closed once the final
    // body is consumed, so keep-alive sockets never linger.
    const dispatchers: Dispatcher[] = [];
    try {
      const response = await this.requestWithValidatedRedirects(url, dispatchers);
      return await this.readResponse(response);
    } finally {
      await Promise.all(
        dispatchers.map((dispatcher) =>
          dispatcher.close().catch(() => {
            /* already closed */
          }),
        ),
      );
    }
  }

  private async readResponse(response: Response): Promise<UrlFetchResult> {
    if (response.status >= 400) {
      // Drain the unused body so undici can release the socket back to
      // the keep-alive pool instead of leaking it on error paths.
      await response.body?.cancel().catch(() => {
        /* already closed */
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    // Reject oversized responses before buffering the full body.
    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        // Drain before throwing: the caller closes per-hop Agents in a
        // finally, and an active oversized stream could stall that close.
        await response.body?.cancel().catch(() => {
          /* already closed */
        });
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const body = await response.text();

    // Servers may omit content-length — measure again defensively.
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
    dispatchers: Dispatcher[],
  ): Promise<Response> {
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      const target = await resolveSafeFetchTarget(currentUrl, this.allowPrivateAddresses);
      const response = await this.fetchImpl(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        redirect: 'manual',
        // `dispatcher` is honored by undici at runtime but absent from
        // DOM's RequestInit type (DOM-lib consumers typecheck this source)
        // — hide it behind `unknown` to stay lib-agnostic.
        dispatcher: this.pinnedDispatcherFor(target, dispatchers) as unknown,
      } as RequestInit);
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      // Drain the unused body so undici can release the socket back to
      // the keep-alive pool instead of leaking it on redirect hops.
      await response.body?.cancel().catch(() => {
        /* already closed */
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
    // Pin only when this request will actually connect directly. When a
    // proxy applies, origin DNS happens on the proxy side (nothing local
    // to pin) and a direct-connect pinned Agent would bypass the proxy
    // entirely. A NO_PROXY bypass still connects directly — keep pinning.
    if (
      isProxyConfigured(process.env) &&
      !makeNoProxyMatcher(resolveNoProxy(process.env))(target.host, target.port)
    ) {
      return undefined;
    }
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup(target.host, target.addresses) },
    });
    dispatchers.push(dispatcher);
    return dispatcher;
  }

  private extractMainContent(html: string): string {
    // Readability mutates the DOM it parses, so parse twice — once for
    // the primary extractor and once for the fallback path.
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
      // Fall through to the container-based fallback.
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
