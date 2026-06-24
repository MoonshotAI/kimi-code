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

function binaryResponse(body: Buffer, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

// Minimal 1x1 PNG (signature + truncated IHDR — enough for sniffing).
const minimalPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, // width = 1
  0x00, 0x00, 0x00, 0x01, // height = 1
  0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, etc.
  0x00, 0x00, 0x00, 0x00, // dummy CRC
]);

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

  it('reports image/png bodies as image kind with base64 data URI and dimensions', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(binaryResponse(minimalPng, 'image/png'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/image.png');

    expect(result.kind).toBe('image');
    expect(result.mimeType).toBe('image/png');
    expect(result.dimensions).toEqual({ width: 1, height: 1 });
    expect(result.content).toMatch(/^data:image\/png;base64,/);
  });

  it('reports image/jpeg bodies as image kind', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(binaryResponse(jpeg, 'image/jpeg'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/image.jpg');

    expect(result.kind).toBe('image');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.content).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects image responses larger than maxBytes', async () => {
    const largePng = Buffer.alloc(11 * 1024 * 1024, 0x00);
    largePng[0] = 0x89;
    largePng[1] = 0x50;
    largePng[2] = 0x4e;
    largePng[3] = 0x47;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(binaryResponse(largePng, 'image/png'));
    const provider = new LocalFetchURLProvider({ fetchImpl, maxBytes: 10 * 1024 * 1024 });

    await expect(provider.fetch('https://example.com/huge.png')).rejects.toThrow('too large');
  });
});
