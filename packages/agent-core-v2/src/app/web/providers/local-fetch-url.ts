import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import { Error2, ErrorCodes } from '#/errors';

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
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult> {
    const response = await this.requestWithRedirects(url, options?.signal);
    return this.readResponse(response);
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
        await response.body?.cancel().catch(() => {
        });
        throw new Error2(
          ErrorCodes.WEB_FETCH_FAILED,
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
          { details: { bytes: cl, maxBytes: this.maxBytes } },
        );
      }
    }

    const body = await response.text();

    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        { details: { bytes: actualBytes, maxBytes: this.maxBytes } },
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }

    return { content: this.extractMainContent(body), kind: 'extracted' };
  }

  private async requestWithRedirects(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      validateFetchUrl(currentUrl);
      const response = await this.fetchImpl(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal,
        redirect: 'manual',
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      await response.body?.cancel().catch(() => {
      });
      if (redirects >= MAX_REDIRECT_HOPS) {
        throw new Error2(
          ErrorCodes.WEB_FETCH_FAILED,
          `Too many redirects while fetching "${url}" (limit ${String(MAX_REDIRECT_HOPS)}).`,
          { details: { url, limit: MAX_REDIRECT_HOPS } },
        );
      }
      redirects += 1;
      currentUrl = new URL(location, currentUrl).toString();
    }
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
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}

function validateFetchUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error2(ErrorCodes.WEB_INVALID_URL, `Invalid URL: "${url}"`, { details: { url } });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error2(
      ErrorCodes.WEB_INVALID_URL,
      `Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`,
      { details: { url, protocol: parsed.protocol } },
    );
  }
}
