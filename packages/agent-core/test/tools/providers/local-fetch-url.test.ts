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

  it('returns image data for image content types', async () => {
    const imageBuffer = Buffer.from('fake-png-data');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(imageBuffer, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/image.png');

    expect(result.kind).toBe('image');
    expect(result.imageData).toBeDefined();
    expect(result.imageData?.mimeType).toBe('image/png');
    expect(result.imageData?.base64).toBe(imageBuffer.toString('base64'));
  });

  it('returns image data for image/jpeg content type', async () => {
    const imageBuffer = Buffer.from('fake-jpeg-data');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(imageBuffer, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/photo.jpg');

    expect(result.kind).toBe('image');
    expect(result.imageData?.mimeType).toBe('image/jpeg');
  });

  it('rejects oversized images', async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB, over default 10MB limit
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(largeBuffer, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(largeBuffer.length) },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/huge.png')).rejects.toThrow('too large');
  });
});
