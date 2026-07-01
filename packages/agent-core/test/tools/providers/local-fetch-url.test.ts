/**
 * Covers: LocalFetchURLProvider content-kind reporting.
 *
 * Verifies the provider tells callers whether the returned content is a
 * verbatim passthrough of the response body or the main text extracted
 * from an HTML page.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalFetchURLProvider } from '../../../src/tools/providers/local-fetch-url';

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('LocalFetchURLProvider content kind', () => {
  it('reports text/plain bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('plain body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/file.txt');

    expect(result).toEqual({ content: 'plain body', kind: 'passthrough' });
  });

  it('reports text/markdown bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('# Title\n\nbody', 'text/markdown'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/readme.md');

    expect(result).toEqual({ content: '# Title\n\nbody', kind: 'passthrough' });
  });

  it('returns image data as base64 for image/* content types', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Buffer.from('fake-png-bytes'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/chart.png');

    expect(result.kind).toBe('image');
    expect(result.content).toBe('');
    expect(result.imageData).toBeDefined();
    expect(result.imageData?.mimeType).toBe('image/png');
    expect(result.imageData?.base64).toBe(Buffer.from('fake-png-bytes').toString('base64'));
  });

  it('reports HTML bodies as extracted main content', async () => {
    const html =
      '<html><head><title>Doc</title></head><body><article>' +
      '<p>The quick brown fox jumps over the lazy dog. '.repeat(20) +
      '</p></article></body></html>';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(html, 'text/html; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/page');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('quick brown fox');
  });
});
