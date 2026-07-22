/**
 * `media` domain (L4) — the `kimi-file://` internal video reference.
 *
 * A prompt video uploaded to `/files` enters context memory as a `video_url`
 * part carrying `kimi-file://<fileId>?path=<encoded absolute path>`: `fileId`
 * addresses the daemon upload the request-time resolver reads bytes from, and
 * the optional `?path=` names the edge-materialized copy the model opens with
 * `ReadMediaFile` when the video cannot be uploaded or inlined. The reference
 * never reaches the provider wire — the resolver rewrites it first. Pure
 * helpers; no scoped service.
 */

const KIMI_FILE_SCHEME = 'kimi-file://';
const PATH_QUERY = '?path=';

export interface KimiFileRef {
  readonly fileId: string;
  readonly path?: string;
}

export function isKimiFileUrl(url: string): boolean {
  return url.startsWith(KIMI_FILE_SCHEME);
}

export function buildKimiFileUrl(fileId: string, path?: string): string {
  const base = `${KIMI_FILE_SCHEME}${fileId}`;
  return path === undefined || path.length === 0
    ? base
    : `${base}${PATH_QUERY}${encodeURIComponent(path)}`;
}

export function parseKimiFileUrl(url: string): KimiFileRef | undefined {
  if (!url.startsWith(KIMI_FILE_SCHEME)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const queryAt = rest.indexOf(PATH_QUERY);
  if (queryAt === -1) {
    return rest.length > 0 ? { fileId: rest } : undefined;
  }
  const fileId = rest.slice(0, queryAt);
  if (fileId.length === 0) return undefined;
  const encoded = rest.slice(queryAt + PATH_QUERY.length);
  if (encoded.length === 0) return { fileId };
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return { fileId };
  }
  return { fileId, path };
}
