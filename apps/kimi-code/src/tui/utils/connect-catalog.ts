import { DEFAULT_CATALOG_URL } from '@moonshot-ai/kimi-code-sdk';

const CATALOG_URL_FLAG_RE = /--url(?:=|\s+)(\S+)/;
const BARE_HTTP_URL_RE = /^https?:\/\/\S+$/;

export interface ConnectCatalogRequest {
  readonly url: string;
  readonly allowBuiltInFallback: boolean;
}

export function resolveConnectCatalogRequest(args: string): ConnectCatalogRequest {
  const trimmed = args.trim();
  const urlMatch = CATALOG_URL_FLAG_RE.exec(trimmed);
  const bareUrl = BARE_HTTP_URL_RE.test(trimmed) ? trimmed : undefined;
  const explicitUrl = urlMatch?.[1] ?? bareUrl;

  return {
    url: explicitUrl ?? DEFAULT_CATALOG_URL,
    allowBuiltInFallback: explicitUrl === undefined,
  };
}
