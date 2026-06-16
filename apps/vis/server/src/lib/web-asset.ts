/** A pre-gzipped self-contained SPA HTML page, served from memory. */
export interface WebAsset {
  /** gzip-compressed bytes of the single-file index.html. */
  readonly gzipped: Uint8Array;
}

/** Serve the embedded SPA for any non-/api GET (SPA fallback: same page for
 *  every client route, since the bundle is a single self-contained HTML). */
export function serveWebAsset(asset: WebAsset): Response {
  return new Response(asset.gzipped, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'cache-control': 'no-store',
    },
  });
}
