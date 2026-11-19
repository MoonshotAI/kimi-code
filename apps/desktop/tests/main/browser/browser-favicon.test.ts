import { expect, it, vi } from 'vitest';
import { loadBrowserFavicon } from '../../../src/main/browser/browser-favicon';

it('loads icons using the supplied browser-session fetcher and embeds their bytes', async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'Content-Type': 'image/x-icon' } }));
  expect(await loadBrowserFavicon(['https://example.com/favicon.ico'], fetcher, new AbortController().signal)).toBe('data:image/x-icon;base64,AAABAA==');
  expect(fetcher).toHaveBeenCalledWith('https://example.com/favicon.ico', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('tries the next candidate after a failed icon and rejects HTML', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('error', { status: 404 })).mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })).mockResolvedValueOnce(new Response('svg', { headers: { 'Content-Type': 'image/svg+xml' } }));
  expect(await loadBrowserFavicon(['https://a.test/1', 'https://a.test/2', 'https://a.test/3'], fetcher, new AbortController().signal)).toBe('data:image/svg+xml;base64,c3Zn');
});

it('bounds response bodies, skips unsafe URLs and respects cancellation', async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array(65537), { headers: { 'Content-Type': 'image/png' } }));
  expect(await loadBrowserFavicon(['javascript:alert(1)'], fetcher, new AbortController().signal)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await loadBrowserFavicon(['https://a.test/large'], fetcher, new AbortController().signal)).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  fetcher.mockClear();
  expect(await loadBrowserFavicon(['https://a.test/icon'], fetcher, controller.signal)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
