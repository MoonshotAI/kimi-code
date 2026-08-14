/**
 * `contract` — media path tag + kimi-file ref recognition for read models.
 *
 * Browser-pure mirror of the engine grammar
 * (`packages/agent-core-v2/src/agent/media/mediaRef.ts`), duplicated
 * because this package must not import the engine — keep the two in sync.
 *
 * A daemon-ref media part is self-contained: the part type carries the kind
 * and the reference the daemon file id, so read models derive the attachment
 * straight from the part via `daemonFileRefFromPairingPart` — there is no
 * tag+ref pairing to compute. A standalone `<media path>` tag in history is
 * user-visible text or the legacy degrade form and always stays a text part.
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
 * tolerated) — the mirror of the engine's `matchSingleMediaPathTag`.
 * Tolerates extra attributes and a missing closing tag, like the engine
 * grammar. Tags embedded in larger user text are NOT matched: stripping
 * there would eat user content.
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

/** The daemon upload reference behind a `kimi-file://<fileId>` url. */
export interface DaemonFileRef {
  readonly fileId: string;
}

/**
 * Parse a `kimi-file://<fileId>` url — the mirror of the engine's
 * `parseDaemonFileUrl`. A legacy `?path=` query (the retired persisted
 * materialization path) is stripped and ignored.
 */
export function parseDaemonFileRef(url: string): DaemonFileRef | undefined {
  if (!url.startsWith(KIMI_FILE_SCHEME)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const queryAt = rest.indexOf('?');
  const fileId = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return fileId.length > 0 ? { fileId } : undefined;
}

/** The daemon upload id behind a `kimi-file://<fileId>` url. */
export function parseDaemonFileRefFileId(url: string): string | undefined {
  return parseDaemonFileRef(url)?.fileId;
}

/**
 * The structural minimum the daemon-ref extraction needs from a content
 * part — the kosong `text` / `image_url` / `video_url` shapes plus anything
 * else.
 */
export interface MediaRefPart {
  readonly type: string;
  readonly text?: string;
  readonly imageUrl?: { readonly url?: string };
  readonly videoUrl?: { readonly url?: string };
}

/**
 * The daemon reference behind a content part, if any — the mirror of the
 * engine's `daemonFileRefFromPart` (keep the two in sync): the kind comes
 * from the part type, the file id from the `kimi-file://` url. This is the
 * single part → ref extraction read models share.
 */
export function daemonFileRefFromPairingPart(
  part: MediaRefPart,
): { readonly kind: 'image' | 'video'; readonly ref: DaemonFileRef } | undefined {
  if (part.type !== 'image_url' && part.type !== 'video_url') return undefined;
  const url = part.type === 'image_url' ? part.imageUrl?.url : part.videoUrl?.url;
  if (typeof url !== 'string') return undefined;
  const ref = parseDaemonFileRef(url);
  if (ref === undefined) return undefined;
  return { kind: part.type === 'image_url' ? 'image' : 'video', ref };
}
