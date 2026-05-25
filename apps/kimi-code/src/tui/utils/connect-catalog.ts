import { DEFAULT_CATALOG_URL } from '@moonshot-ai/kimi-code-sdk';

const CATALOG_URL_FLAG_RE = /--url(?:=|\s+)(https?:\/\/\S+)/;
const URL_FLAG_PRESENT_RE = /(?:^|\s)--url(?=\s|=|$)/;
const REFRESH_FLAG_RE = /(?:^|\s)--refresh(?=\s|$)/;
const BARE_HTTP_URL_RE = /^https?:\/\/\S+$/;

export interface ConnectCatalogRequest {
  readonly url: string;
  readonly preferBuiltIn: boolean;
  readonly allowBuiltInFallback: boolean;
}

export type ConnectCatalogResolution =
  | { readonly kind: 'ok'; readonly request: ConnectCatalogRequest }
  | { readonly kind: 'error'; readonly message: string };

export function resolveConnectCatalogRequest(args: string): ConnectCatalogResolution {
  const trimmed = args.trim();
  const urlMatch = CATALOG_URL_FLAG_RE.exec(trimmed);
  const bareUrl = BARE_HTTP_URL_RE.test(trimmed) ? trimmed : undefined;
  const explicitUrl = urlMatch?.[1] ?? bareUrl;

  if (explicitUrl !== undefined) {
    return {
      kind: 'ok',
      request: {
        url: explicitUrl,
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    };
  }

  if (URL_FLAG_PRESENT_RE.test(trimmed)) {
    return {
      kind: 'error',
      message:
        '--url requires an http(s) URL value, e.g. /connect --url=https://example.com/catalog.json',
    };
  }

  const refreshRequested = REFRESH_FLAG_RE.test(trimmed);
  return {
    kind: 'ok',
    request: {
      url: DEFAULT_CATALOG_URL,
      preferBuiltIn: !refreshRequested,
      allowBuiltInFallback: true,
    },
  };
}
