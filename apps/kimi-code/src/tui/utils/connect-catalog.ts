import { DEFAULT_CATALOG_URL } from '@moonshot-ai/kimi-code-sdk';

const CATALOG_URL_FLAG_RE = /--url(?:=|\s+)(\S+)/;
const REFRESH_FLAG_RE = /(?:^|\s)--refresh(?=\s|$)/;
const BARE_HTTP_URL_RE = /^https?:\/\/\S+$/;

export interface ConnectCatalogRequest {
  readonly url: string;
  readonly preferBuiltIn: boolean;
  readonly allowBuiltInFallback: boolean;
}

export function resolveConnectCatalogRequest(args: string): ConnectCatalogRequest {
  const trimmed = args.trim();
  const urlMatch = CATALOG_URL_FLAG_RE.exec(trimmed);
  const bareUrl = BARE_HTTP_URL_RE.test(trimmed) ? trimmed : undefined;
  const explicitUrl = urlMatch?.[1] ?? bareUrl;

  if (explicitUrl !== undefined) {
    return {
      url: explicitUrl,
      preferBuiltIn: false,
      allowBuiltInFallback: false,
    };
  }

  const refreshRequested = REFRESH_FLAG_RE.test(trimmed);
  return {
    url: DEFAULT_CATALOG_URL,
    preferBuiltIn: !refreshRequested,
    allowBuiltInFallback: true,
  };
}
