import { asBrowserFavicon } from '../../shared/browser';

const MAX_BYTES = 64 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif']);

export async function loadBrowserFavicon(urls: readonly string[], fetcher: (url: string, init: RequestInit) => Promise<Response>, signal: AbortSignal): Promise<string | undefined> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  for (const url of [...new Set(urls)].slice(0, 4)) {
    if (bounded.aborted) return undefined;
    const valid = asBrowserFavicon(url);
    if (valid === null) continue;
    if (valid.startsWith('data:image/')) return valid;
    try {
      const response = await fetcher(valid, { signal: bounded, headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); continue; }
      const reader = response.body?.getReader();
      if (!reader) continue;
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); break; }
        chunks.push(next.value);
      }
      if (size > MAX_BYTES || size === 0 || bounded.aborted) continue;
      const bytes = Buffer.concat(chunks);
      let mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!MIME_TYPES.has(mime)) {
        if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) mime = 'image/x-icon';
        else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
        else continue;
      }
      return `data:${mime};base64,${bytes.toString('base64')}`;
    } catch { if (bounded.aborted) return undefined; }
  }
  return undefined;
}
