const MEDIA_REF_SCHEME = 'media://';

export function buildMediaRefUrl(ref: string): string {
  return `${MEDIA_REF_SCHEME}${ref}`;
}

export function parseMediaRefUrl(url: string): string | undefined {
  if (!url.startsWith(MEDIA_REF_SCHEME)) return undefined;
  const ref = url.slice(MEDIA_REF_SCHEME.length);
  return ref.length > 0 ? ref : undefined;
}
