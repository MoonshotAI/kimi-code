/**
 * `contract` — media path tag + kimi-file ref recognition for read models.
 *
 * Browser-pure mirror of the engine grammar
 * (`packages/agent-core-v2/src/kosong/contract/mediaRef.ts`), duplicated
 * because this package must not import the engine — keep the two in sync.
 * An upload edge persists a medium as the pair `<media path> tag text part +
 * `kimi-file://` media part; read models fold the pair into a single
 * attachment and never render the tag as text.
 */

export type MediaPathTagKind = 'image' | 'video' | 'audio' | 'file';

export interface MediaPathTagMatch {
  readonly kind: MediaPathTagKind;
  readonly path: string;
}

const SINGLE_MEDIA_PATH_TAG_RE =
  /^\s*<(image|video|audio|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?\s*$/;

/**
 * The whole text is exactly one media path tag (surrounding whitespace
 * tolerated) — the shape upload edges emit as a standalone text part next to
 * the daemon-ref media part. Tolerates extra attributes and a missing
 * closing tag, like the engine grammar. Tags embedded in larger user text
 * are NOT matched: stripping there would eat user content.
 */
export function matchMediaPathTagText(text: string): MediaPathTagMatch | undefined {
  const match = SINGLE_MEDIA_PATH_TAG_RE.exec(text);
  if (match === null) return undefined;
  return { kind: match[1] as MediaPathTagKind, path: unescapeMediaAttribute(match[2]!) };
}

function unescapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

const KIMI_FILE_SCHEME = 'kimi-file://';
const PATH_QUERY = '?path=';

/** The daemon upload id behind a `kimi-file://<fileId>[?path=…]` url. */
export function parseKimiFileRefFileId(url: string): string | undefined {
  if (!url.startsWith(KIMI_FILE_SCHEME)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const queryAt = rest.indexOf(PATH_QUERY);
  const fileId = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return fileId.length > 0 ? fileId : undefined;
}
