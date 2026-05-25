import { DEFAULT_CATALOG_URL } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { resolveConnectCatalogRequest } from '#/tui/utils/connect-catalog';

describe('resolveConnectCatalogRequest', () => {
  it('uses the default catalog and permits built-in fallback when no URL is specified', () => {
    expect(resolveConnectCatalogRequest('')).toEqual({
      url: DEFAULT_CATALOG_URL,
      allowBuiltInFallback: true,
    });
    expect(resolveConnectCatalogRequest('ignored text')).toEqual({
      url: DEFAULT_CATALOG_URL,
      allowBuiltInFallback: true,
    });
  });

  it('treats explicit catalog URLs as authoritative', () => {
    expect(resolveConnectCatalogRequest('--url=https://internal.example/catalog.json')).toEqual({
      url: 'https://internal.example/catalog.json',
      allowBuiltInFallback: false,
    });
    expect(resolveConnectCatalogRequest('--url https://internal.example/catalog.json')).toEqual({
      url: 'https://internal.example/catalog.json',
      allowBuiltInFallback: false,
    });
    expect(resolveConnectCatalogRequest('https://internal.example/catalog.json')).toEqual({
      url: 'https://internal.example/catalog.json',
      allowBuiltInFallback: false,
    });
  });
});
