export interface WebAsset {
  readonly gzipped: Uint8Array;
}

export function serveWebAsset(asset: WebAsset): Response {
  return new Response(asset.gzipped, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'cache-control': 'no-store',
    },
  });
}
