import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CATALOG_URL, loadBuiltInCatalog } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { BUILT_IN_CATALOG_JSON } from '#/built-in-catalog';
import { resolveConnectCatalogRequest } from '#/tui/utils/connect-catalog';

import { builtInCatalogDefine } from '../../../scripts/built-in-catalog.mjs';

describe('resolveConnectCatalogRequest', () => {
  it('prefers the built-in catalog by default and keeps online fetch as fallback', () => {
    expect(resolveConnectCatalogRequest('')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: true,
        allowBuiltInFallback: true,
      },
    });
    expect(resolveConnectCatalogRequest('ignored text')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: true,
        allowBuiltInFallback: true,
      },
    });
  });

  it('forces an online fetch when --refresh is requested', () => {
    expect(resolveConnectCatalogRequest('--refresh')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: false,
        allowBuiltInFallback: true,
      },
    });
    expect(resolveConnectCatalogRequest('  --refresh  ')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: false,
        allowBuiltInFallback: true,
      },
    });
  });

  it('treats explicit catalog URLs as authoritative and ignores --refresh on them', () => {
    expect(resolveConnectCatalogRequest('--url=https://internal.example/catalog.json')).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
    expect(resolveConnectCatalogRequest('--url https://internal.example/catalog.json')).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
    expect(resolveConnectCatalogRequest('https://internal.example/catalog.json')).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
    expect(
      resolveConnectCatalogRequest('--refresh --url=https://internal.example/catalog.json'),
    ).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
  });

  it('rejects --url when no value or a non-URL value is provided', () => {
    const expectedMessage =
      '--url requires an http(s) URL value, e.g. /connect --url=https://example.com/catalog.json';
    expect(resolveConnectCatalogRequest('--url')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
    expect(resolveConnectCatalogRequest('--url=')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
    expect(resolveConnectCatalogRequest('  --url  ')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
    expect(resolveConnectCatalogRequest('--refresh --url')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
    // Flag-like tokens after --url must not be swallowed as the URL value.
    expect(resolveConnectCatalogRequest('--url --refresh')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
    // Plain non-URL tokens must also be rejected, not silently used.
    expect(resolveConnectCatalogRequest('--url not-a-url')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
    expect(resolveConnectCatalogRequest('--url=ftp://example.com/x')).toEqual({
      kind: 'error',
      message: expectedMessage,
    });
  });
});

describe('built-in connect catalog injection', () => {
  it('keeps the source placeholder empty so generated catalog data is not committed', () => {
    expect(BUILT_IN_CATALOG_JSON).toBeUndefined();
    expect(loadBuiltInCatalog(BUILT_IN_CATALOG_JSON)).toBeUndefined();
  });

  it('embeds a generated catalog file through the tsdown define value', async () => {
    const catalog = {
      openai: {
        id: 'openai',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-test': {
            id: 'gpt-test',
            limit: { context: 1000, output: 100 },
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'kimi-built-in-catalog-'));
    try {
      const file = join(dir, 'catalog.json');
      const text = JSON.stringify(catalog);
      await writeFile(file, text, 'utf-8');

      const defineValue = builtInCatalogDefine({ KIMI_CODE_BUILT_IN_CATALOG_FILE: file });
      expect(JSON.parse(defineValue)).toBe(text);
      expect(loadBuiltInCatalog(JSON.parse(defineValue))).toEqual(catalog);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
