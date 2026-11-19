const MAX_ENCODED_FILENAME_LENGTH = 2048;
const MAX_FALLBACK_FILENAME_LENGTH = 256;

export function buildContentDisposition(
  name: string,
  mediaType?: string,
  dispositionOverride?: 'inline' | 'attachment',
): string {
  const disposition = dispositionOverride ?? (/^(image|video|audio)\//.test(mediaType ?? '') ? 'inline' : 'attachment');
  const fallback = name.replaceAll(/[^\u0020-\u007E]/g, '_').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const encoded = encodeURIComponent(name).replaceAll(/['()*]/g, (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`);
  const tooLong = encoded.length > MAX_ENCODED_FILENAME_LENGTH;
  const safeFallback = tooLong
    ? name.slice(0, MAX_FALLBACK_FILENAME_LENGTH).replaceAll(/[^\u0020-\u007E]/g, '_').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    : fallback;
  const filenameStar = fallback === name || tooLong ? '' : `; filename*=UTF-8''${encoded}`;
  return `${disposition}; filename="${safeFallback}"${filenameStar}`;
}
