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

  it('reports image/png bodies as base64 markdown image', async () => {
    const imageBuffer = Buffer.from('fake-png-binary-data');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(imageBuffer, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/image.png');

    expect(result.kind).toBe('image');
    expect(result.content).toMatch(/^!\[image\]\(data:image\/png;base64,/);
    expect(result.content).toContain(Buffer.from('fake-png-binary-data').toString('base64'));
  });

  it('reports image/jpeg bodies as base64 markdown image', async () => {
    const imageBuffer = Buffer.from('fake-jpeg-binary-data');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(imageBuffer, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/image.jpg');

    expect(result.kind).toBe('image');
    expect(result.content).toMatch(/^!\[image\]\(data:image\/jpeg;base64,/);
  });

  it('reports image/svg+xml bodies as base64 markdown image with svg extension', async () => {
    const svgBuffer = Buffer.from('<svg></svg>');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(svgBuffer, { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/icon.svg');

    expect(result.kind).toBe('image');
    expect(result.content).toMatch(/^!\[image\]\(data:image\/svg;base64,/);
  });

  it('rejects image responses that exceed maxBytes', async () => {
    const largeImage = Buffer.alloc(15 * 1024 * 1024); // 15 MB
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(largeImage, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(15 * 1024 * 1024) } }),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/huge.png')).rejects.toThrow('too large');
  });
});
