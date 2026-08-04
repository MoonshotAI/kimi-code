/**
 * `kosong/contract` domain — media classification and daemon file references.
 *
 * "Media kind" is the classification every upload edge, resolver, and
 * projection agrees on: `image`, `video`, and `audio` (the media content-part
 * kinds a model can consume) plus `file` (anything else, which always
 * degrades to a path reference). The helpers derive the kind from a content
 * part, a MIME type, or a path suffix, and the suffix tables are the single
 * source of truth for suffix ↔ MIME mapping — `agent/media/file-type`
 * re-exports them for its magic-byte detection.
 *
 * A daemon file reference is the internal `kimi-file://<fileId>?path=<encoded
 * absolute path>` URL: `fileId` addresses the daemon upload the request-time
 * media resolver reads bytes from, and the optional `?path=` names the
 * edge-materialized copy the model opens with `ReadMediaFile` when the media
 * cannot be uploaded or inlined. The reference lives in context memory and
 * never reaches the provider wire — the resolver rewrites it first. The kind
 * of a referenced file is carried by the enclosing content part (`image_url`
 * / `video_url`), never by the URL itself, so existing references stay valid.
 *
 * The `<image|video|audio|file path="…">` tag is the model-facing
 * degradation form: the resolver (or an edge) swaps a media part for the tag
 * when the bytes cannot reach the provider, and clients parse it back to
 * render or re-open the file. Emission escapes the path as an XML attribute;
 * parsing unescapes it and tolerates extra attributes and a missing closing
 * tag.
 *
 * Pure types and pure functions only — no other domain, no I/O, no SDKs.
 */

import type { ContentPart } from './message';

/** Media category shared by upload edges, resolvers, and projections. */
export type MediaKind = 'image' | 'video' | 'audio' | 'file';

// ---------------------------------------------------------------------------
// Suffix ↔ MIME tables (single source of truth; `agent/media/file-type`
// re-exports them for its magic-byte detection).
// ---------------------------------------------------------------------------

export const IMAGE_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.svgz': 'image/svg+xml',
});

export const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
});

export const AUDIO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
});

function mediaSuffix(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx <= lastSep + 1) return '';
  return path.slice(idx).toLowerCase();
}

/** Classify a file path as `image` / `video` / `audio` from its suffix. */
export function mediaKindForPath(path: string): 'image' | 'video' | 'audio' | undefined {
  const suffix = mediaSuffix(path);
  if (suffix in IMAGE_MIME_BY_SUFFIX) return 'image';
  if (suffix in VIDEO_MIME_BY_SUFFIX) return 'video';
  if (suffix in AUDIO_MIME_BY_SUFFIX) return 'audio';
  return undefined;
}

/** Classify a MIME type as `image` / `video` / `audio`; anything else is `file`-grade. */
export function mediaKindForMime(mimeType: string): 'image' | 'video' | 'audio' | undefined {
  const semi = mimeType.indexOf(';');
  const base = (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim().toLowerCase();
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('audio/')) return 'audio';
  return undefined;
}

/** Media kind implied by a content part's type, when it carries one. */
export function mediaKindOfPart(part: ContentPart): 'image' | 'video' | 'audio' | undefined {
  if (part.type === 'image_url') return 'image';
  if (part.type === 'video_url') return 'video';
  if (part.type === 'audio_url') return 'audio';
  return undefined;
}

// ---------------------------------------------------------------------------
// Daemon file reference (`kimi-file://`).
// ---------------------------------------------------------------------------

const KIMI_FILE_SCHEME = 'kimi-file://';
const PATH_QUERY = '?path=';

export interface DaemonFileRef {
  readonly fileId: string;
  readonly path?: string;
}

export function isDaemonFileUrl(url: string): boolean {
  return url.startsWith(KIMI_FILE_SCHEME);
}

export function buildDaemonFileUrl(fileId: string, path?: string): string {
  const base = `${KIMI_FILE_SCHEME}${fileId}`;
  return path === undefined || path.length === 0
    ? base
    : `${base}${PATH_QUERY}${encodeURIComponent(path)}`;
}

export function parseDaemonFileUrl(url: string): DaemonFileRef | undefined {
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

/**
 * The daemon file reference a content part carries, tagged with the media
 * kind the part type implies. Plain remote / data URLs return undefined.
 */
export function daemonFileRefFromPart(
  part: ContentPart,
): { readonly kind: 'image' | 'video'; readonly ref: DaemonFileRef } | undefined {
  if (part.type === 'image_url') {
    const ref = parseDaemonFileUrl(part.imageUrl.url);
    return ref === undefined ? undefined : { kind: 'image', ref };
  }
  if (part.type === 'video_url') {
    const ref = parseDaemonFileUrl(part.videoUrl.url);
    return ref === undefined ? undefined : { kind: 'video', ref };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `<image|video|audio|file path="…">` tags — the model-facing degradation form.
// ---------------------------------------------------------------------------

const MEDIA_PATH_TAG_RE = /<(image|video|audio|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?/g;

export interface MediaPathTag {
  readonly kind: MediaKind;
  readonly path: string;
  /** Index of the tag's first character in the source text. */
  readonly index: number;
  /** The full matched text, including the closing tag when present. */
  readonly text: string;
}

export function escapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function unescapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function buildMediaPathTag(kind: MediaKind, path: string): string {
  return `<${kind} path="${escapeMediaAttribute(path)}"></${kind}>`;
}

/**
 * Every media path tag in `text`, in order. Tolerates extra attributes (the
 * Kimi Chat `content_type` / `width` / `height` form) and a missing closing
 * tag — both shapes exist in persisted sessions.
 */
export function matchMediaPathTags(text: string): MediaPathTag[] {
  const tags: MediaPathTag[] = [];
  for (const match of text.matchAll(MEDIA_PATH_TAG_RE)) {
    tags.push({
      kind: match[1] as MediaKind,
      path: unescapeMediaAttribute(match[2]!),
      index: match.index,
      text: match[0],
    });
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Tag + daemon-ref fold — the read-model normalization of the upload pair.
// ---------------------------------------------------------------------------

/**
 * The whole (trimmed) text is exactly one media path tag — the shape upload
 * edges emit as a standalone text part next to the daemon-ref media part.
 * Tags embedded in larger user text are NOT matched: stripping there would
 * eat user content.
 */
export function matchSingleMediaPathTag(text: string): MediaPathTag | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const tags = matchMediaPathTags(trimmed);
  if (tags.length !== 1) return undefined;
  const tag = tags[0]!;
  return tag.index === 0 && tag.text.length === trimmed.length ? tag : undefined;
}

export interface FoldedMediaRef {
  readonly kind: 'image' | 'video';
  readonly ref: DaemonFileRef;
  /** Model-facing path carried by the paired adjacent tag; absent for a bare ref. */
  readonly path?: string;
}

export interface MediaPathTagFold {
  /**
   * Input parts minus the standalone media-tag text parts claimed by a daemon
   * ref. An unpaired standalone tag STAYS as a text part: without a pairing
   * ref it is user-visible text, not markup the read model may eat.
   */
  readonly parts: ContentPart[];
  /** One entry per daemon-ref media part, in input order. */
  readonly media: FoldedMediaRef[];
}

/**
 * The claim analysis behind the tag + daemon-ref fold — the single pairing
 * algorithm {@link foldMediaPathTagRefs} and the request-time media resolver
 * share, so the two can never drift apart.
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

export function pairMediaPathTagRefs(parts: readonly ContentPart[]): MediaPathTagPairing {
  const tagByIndex = new Map<number, MediaPathTag>();
  const refByIndex = new Map<number, { kind: 'image' | 'video'; path?: string }>();
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      const tag = matchSingleMediaPathTag(part.text);
      if (tag !== undefined) tagByIndex.set(index, tag);
      return;
    }
    const ref = daemonFileRefFromPart(part);
    if (ref !== undefined) refByIndex.set(index, { kind: ref.kind, path: ref.ref.path });
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

/**
 * Fold the upload pair `<media path> tag text part + daemon-ref media part`
 * for read models: a CLAIMED tag text part disappears (it is machine markup —
 * see {@link pairMediaPathTagRefs} for the pairing rules), and each daemon-ref
 * media part yields one {@link FoldedMediaRef} — carrying the paired tag's
 * path, or none for a bare ref. An unpaired standalone tag stays as a text
 * part; non-daemon media parts and all other parts pass through.
 */
export function foldMediaPathTagRefs(parts: readonly ContentPart[]): MediaPathTagFold {
  const pairing = pairMediaPathTagRefs(parts);
  const kept: ContentPart[] = [];
  const media: FoldedMediaRef[] = [];
  parts.forEach((part, index) => {
    if (pairing.claimedTagIndices.has(index)) return;
    kept.push(part);
    const ref = daemonFileRefFromPart(part);
    if (ref === undefined) return;
    media.push({
      kind: ref.kind,
      ref: ref.ref,
      path: pairing.claimedPathByRefIndex.get(index),
    });
  });
  return { parts: kept, media };
}
