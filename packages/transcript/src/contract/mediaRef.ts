/**
 * `contract` — media path tag + kimi-file ref recognition for read models.
 *
 * Browser-pure mirror of the engine grammar
 * (`packages/agent-core-v2/src/agent/media/mediaRef.ts`), duplicated
 * because this package must not import the engine — keep the two in sync.
 * An upload edge persists a medium as the pair `<media path> tag text part +
 * `kimi-file://` media part; read models fold the pair into a single
 * attachment and never render the tag as text. `pairMediaPathTagRefs` decides
 * which tag claims which ref (standalone tag only, adjacent, kind-compatible,
 * path-equal, single-claim); an unpaired standalone tag stays as text.
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

/** The daemon upload reference behind a `kimi-file://<fileId>[?path=…]` url. */
export interface KimiFileRef {
  readonly fileId: string;
  readonly path?: string;
}

/**
 * Parse a `kimi-file://<fileId>[?path=<encoded absolute path>]` url — the
 * mirror of the engine's `parseDaemonFileUrl`. An undecodable path is dropped
 * but the file id keeps parsing.
 */
export function parseKimiFileRef(url: string): KimiFileRef | undefined {
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

/** The daemon upload id behind a `kimi-file://<fileId>[?path=…]` url. */
export function parseKimiFileRefFileId(url: string): string | undefined {
  return parseKimiFileRef(url)?.fileId;
}

// ---------------------------------------------------------------------------
// Tag + daemon-ref pairing — the mirror of the engine's `pairMediaPathTagRefs`.
// ---------------------------------------------------------------------------

/**
 * The structural minimum the pairing algorithm needs from a content part —
 * the kosong `text` / `image_url` / `video_url` shapes plus anything else.
 */
export interface MediaRefPairingPart {
  readonly type: string;
  readonly text?: string;
  readonly imageUrl?: { readonly url?: string };
  readonly videoUrl?: { readonly url?: string };
}

/**
 * The claim analysis behind the tag + daemon-ref fold — the mirror of the
 * engine's algorithm (keep the two in sync).
 *
 * Pairing rules:
 *   - only a STANDALONE tag (the whole text part is exactly one media path
 *     tag) participates; a tag embedded in other text never does;
 *   - a tag pairs with a daemon-ref media part immediately before or after it
 *     (edges emit tag-before-ref; persisted history also has ref-before-tag)
 *     when the kinds are compatible — a `file` tag matches either ref kind —
 *     AND the tag's path equals the path the reference carries. A reference
 *     without a path can never pair: both sides stay, conservatively;
 *   - each tag claims at most one reference and each reference is claimed by
 *     at most one tag; references claim in input order, checking the part
 *     before them first.
 */
export interface MediaPathTagPairing {
  /** Standalone media-tag text part indices claimed by an adjacent daemon ref. */
  readonly claimedTagIndices: ReadonlySet<number>;
  /** The claiming tag's path per daemon-ref part index; absent for an unpaired ref. */
  readonly claimedPathByRefIndex: ReadonlyMap<number, string>;
}

export function pairMediaPathTagRefs(
  parts: readonly MediaRefPairingPart[],
): MediaPathTagPairing {
  const tagByIndex = new Map<number, MediaPathTagMatch>();
  const refByIndex = new Map<number, { kind: 'image' | 'video'; path?: string }>();
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      const tag = typeof part.text === 'string' ? matchMediaPathTagText(part.text) : undefined;
      if (tag !== undefined) tagByIndex.set(index, tag);
      return;
    }
    if (part.type !== 'image_url' && part.type !== 'video_url') return;
    const url = part.type === 'image_url' ? part.imageUrl?.url : part.videoUrl?.url;
    if (typeof url !== 'string') return;
    const ref = parseKimiFileRef(url);
    if (ref !== undefined) {
      refByIndex.set(index, { kind: part.type === 'image_url' ? 'image' : 'video', path: ref.path });
    }
  });
  const claimedTagIndices = new Set<number>();
  const claimedPathByRefIndex = new Map<number, string>();
  for (const [refIndex, ref] of refByIndex) {
    if (ref.path === undefined) continue;
    for (const neighbor of [refIndex - 1, refIndex + 1]) {
      const tag = tagByIndex.get(neighbor);
      if (tag === undefined || claimedTagIndices.has(neighbor)) continue;
      if (tag.kind !== 'file' && tag.kind !== ref.kind) continue;
      if (tag.path !== ref.path) continue;
      claimedTagIndices.add(neighbor);
      claimedPathByRefIndex.set(refIndex, tag.path);
      break;
    }
  }
  return { claimedTagIndices, claimedPathByRefIndex };
}
