/**
 * Scan submitted text for media placeholders and produce the prompt content
 * we'll send to the SDK prompt endpoint.
 *
 * Two extraction paths share the same placeholder scan:
 *
 *   - `extractMediaAttachments` (sync): image placeholders expand to image
 *     content parts; video placeholders are copied into the shared cache
 *     (`getCacheDir()`) and expand to `<video path="…">` file tags, so the
 *     model opens them with `ReadMediaFile`. Used by channels that cannot
 *     upload first (steer splice, `/skill` args via rewriteMediaPlaceholders,
 *     plugin commands) and as the fallback when a prompt-time video upload
 *     fails.
 *   - `extractMediaSegments` + `materializeMediaSegments` (async): video
 *     placeholders stay unresolved references until `materializeMediaSegments`
 *     uploads each one through the session's video upload channel and embeds
 *     the provider-issued `video_url` part directly in the prompt — the model
 *     receives the video with the user message, no tool call needed. An
 *     upload that fails falls back to the file-tag form above.
 *
 * Rules for both:
 *   - Only placeholders that resolve against `store` get extracted.
 *     A literal `[image #999 ...]` the user typed themselves stays in
 *     the text (we can't hallucinate files for it).
 *   - Order is preserved for text/image/video segments. Image placeholders
 *     expand to image content parts so the prompt reaches the provider
 *     without relying on a model tool call.
 *   - Adjacent text segments are flattened — empty / whitespace-only
 *     segments drop out so we never emit `{type:'text', text:' '}`
 *     noise between two media parts.
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';
import { buildImageCompressionCaption } from '@moonshot-ai/kimi-code-sdk';

import { getCacheDir } from '#/utils/paths';

import type {
  ImageAttachment,
  ImageAttachmentStore,
  VideoAttachment,
} from './image-attachment-store';

const PLACEHOLDER_REGEX = /\[(image|video) #(\d+) (?:(\(\d+×\d+\))|([^\]]+))\]/g;

export interface ExtractionResult {
  /** Flat list of parts in input order; empty array when no media matched. */
  parts: PromptPart[];
  /**
   * Did we find at least one matching attachment? When false, callers
   * should keep the prompt on the plain text path.
   */
  hasMedia: boolean;
  /** Image attachment ids matched, in the order they appeared. */
  imageAttachmentIds: number[];
  /** Video attachment ids matched, in the order they appeared. */
  videoAttachmentIds: number[];
}

export function extractMediaAttachments(
  text: string,
  store: ImageAttachmentStore,
): ExtractionResult {
  const parts: PromptPart[] = [];
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  let cursor = 0;
  let hasMedia = false;

  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [literal, kind, idStr] = match;
    if (kind !== 'image' && kind !== 'video') continue;
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    const attachment = store.get(id);
    if (attachment === undefined) continue; // stale / user-typed — leave as text
    if (attachment.kind !== kind) continue;
    const before = text.slice(cursor, match.index);
    pushText(parts, before);
    if (attachment.kind === 'video') {
      const cachePath = materializeVideoToCache(attachment);
      pushText(parts, formatMediaTag('video', cachePath));
      videoAttachmentIds.push(id);
    } else {
      // Paste-time compression is announced next to the image so the model
      // knows it received a downsampled copy and where the original lives.
      if (attachment.original !== undefined) {
        pushText(parts, captionForCompressedImage(attachment));
      }
      parts.push(imagePartForAttachment(attachment));
      imageAttachmentIds.push(id);
    }
    hasMedia = true;
    cursor = match.index + literal.length;
  }
  const tail = text.slice(cursor);
  pushText(parts, tail);

  return {
    // Text-only submissions drop the synthesised parts array — the
    // caller's contract is "parts is meaningful iff hasMedia", and
    // emitting a stray TextPart confuses consumers that branch on
    // `parts.length > 0`.
    parts: hasMedia ? parts : [],
    hasMedia,
    imageAttachmentIds,
    videoAttachmentIds,
  };
}

export interface MediaSegmentPart {
  readonly kind: 'part';
  readonly part: PromptPart;
}

export interface MediaSegmentVideo {
  readonly kind: 'video';
  readonly attachment: VideoAttachment;
}

export type MediaSegment = MediaSegmentPart | MediaSegmentVideo;

export interface SegmentExtractionResult {
  /** Ordered segments: text/image parts inline, videos as unresolved refs. */
  readonly segments: MediaSegment[];
  readonly hasMedia: boolean;
  readonly imageAttachmentIds: number[];
  readonly videoAttachmentIds: number[];
}

/**
 * Variant of `extractMediaAttachments` that leaves video placeholders
 * unresolved: the returned segments keep the `VideoAttachment` so the caller
 * can upload it (async) before deciding the final part shape. No cache copy
 * happens here, so unlike `extractMediaAttachments` this never throws for a
 * vanished video source — that surfaces only if the tag fallback runs.
 */
export function extractMediaSegments(
  text: string,
  store: ImageAttachmentStore,
): SegmentExtractionResult {
  const segments: MediaSegment[] = [];
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  let cursor = 0;
  let hasMedia = false;

  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [literal, kind, idStr] = match;
    if (kind !== 'image' && kind !== 'video') continue;
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    const attachment = store.get(id);
    if (attachment === undefined) continue; // stale / user-typed — leave as text
    if (attachment.kind !== kind) continue;
    const before = text.slice(cursor, match.index);
    pushTextPart(segments, before);
    if (attachment.kind === 'video') {
      segments.push({ kind: 'video', attachment });
      videoAttachmentIds.push(id);
    } else {
      if (attachment.original !== undefined) {
        pushTextPart(segments, captionForCompressedImage(attachment));
      }
      segments.push({ kind: 'part', part: imagePartForAttachment(attachment) });
      imageAttachmentIds.push(id);
    }
    hasMedia = true;
    cursor = match.index + literal.length;
  }
  pushTextPart(segments, text.slice(cursor));

  return {
    segments: hasMedia ? segments : [],
    hasMedia,
    imageAttachmentIds,
    videoAttachmentIds,
  };
}

/**
 * Resolve extracted segments into final prompt parts. Text and image
 * segments pass through; each video attachment is uploaded through `upload`
 * (the session's video upload channel) so the prompt embeds the
 * provider-issued `video_url` part directly. When an upload fails the video
 * degrades to a `<video path="…">` tag pointing at a cache copy, which the
 * model can open with `ReadMediaFile` — uploads run concurrently, order is
 * preserved. Throws only when a fallback cache copy itself fails.
 */
export async function materializeMediaSegments(
  segments: readonly MediaSegment[],
  upload: (attachment: VideoAttachment) => Promise<PromptPart>,
): Promise<PromptPart[]> {
  const resolved = await Promise.all(
    segments.map(async (segment): Promise<PromptPart[]> => {
      if (segment.kind === 'part') return [segment.part];
      try {
        return [await upload(segment.attachment)];
      } catch {
        // Fall back to the file-tag form: the model reads the video itself.
        const cachePath = materializeVideoToCache(segment.attachment);
        return [{ type: 'text', text: formatMediaTag('video', cachePath) }];
      }
    }),
  );
  return resolved.flat();
}

/**
 * Resolve already-extracted segments that contain no video placeholders into
 * prompt parts synchronously (all segments are inline parts by then).
 */
export function segmentsToPromptParts(segments: readonly MediaSegment[]): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const segment of segments) {
    if (segment.kind === 'part') parts.push(segment.part);
  }
  return parts;
}

export interface MediaTagRewriteResult {
  /** Input text with resolved placeholders replaced by media references. */
  text: string;
  hasMedia: boolean;
  imageAttachmentIds: number[];
  videoAttachmentIds: number[];
}

/**
 * How a resolved placeholder is rendered into command args:
 *  - `'tag'`: the `<image|video path="…"></…>` convention, for channels
 *    that pass args through verbatim (plugin commands).
 *  - `'plain'`: a plain-text file reference with no XML tag/attribute
 *    boundary characters, for channels that XML-escape args (`/skill`
 *    args are escaped by both `renderSkillAttributes` and
 *    `expandSkillParameters`, which would mangle the tag form).
 */
export type MediaReferenceStyle = 'tag' | 'plain';

/**
 * Rewrite media placeholders in slash-command args (`/skill:foo …`,
 * plugin commands) into references pointing at cache-dir copies. Command
 * args are a plain-text channel — unlike `extractMediaAttachments`, which
 * inlines image parts for the prompt endpoint — so the model reaches the
 * media through `ReadMediaFile` instead, the same way it already handles
 * pasted videos.
 *
 * Surrounding text is preserved verbatim (args are user content, not
 * LLM parts), and unresolved placeholders stay literal.
 */
export function rewriteMediaPlaceholders(
  text: string,
  store: ImageAttachmentStore,
  style: MediaReferenceStyle = 'tag',
): MediaTagRewriteResult {
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  let cursor = 0;
  let out = '';

  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [literal, kind, idStr] = match;
    if (kind !== 'image' && kind !== 'video') continue;
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    const attachment = store.get(id);
    if (attachment === undefined) continue; // stale / user-typed — leave as text
    if (attachment.kind !== kind) continue;
    out += text.slice(cursor, match.index);
    if (attachment.kind === 'video') {
      const path = materializeVideoToCache(attachment, style === 'plain');
      out += style === 'plain' ? formatMediaReference('video', path) : formatMediaTag('video', path);
      videoAttachmentIds.push(id);
    } else {
      const path = materializeImageToCache(attachment);
      out += style === 'plain' ? formatMediaReference('image', path) : formatMediaTag('image', path);
      imageAttachmentIds.push(id);
    }
    cursor = match.index + literal.length;
  }

  const hasMedia = imageAttachmentIds.length + videoAttachmentIds.length > 0;
  return {
    text: hasMedia ? out + text.slice(cursor) : text,
    hasMedia,
    imageAttachmentIds,
    videoAttachmentIds,
  };
}

function pushText(parts: PromptPart[], segment: string): void {
  if (segment.length === 0) return;
  // Keep whitespace-only segments only when they sit between non-empty
  // text elsewhere — the simpler rule "drop everything whitespace-only"
  // is fine here because the LLM doesn't care about inter-image spaces.
  if (segment.trim().length === 0) return;
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + segment };
    return;
  }
  parts.push({ type: 'text', text: segment });
}

function pushTextPart(segments: MediaSegment[], segment: string): void {
  if (segment.length === 0) return;
  if (segment.trim().length === 0) return;
  const last = segments.at(-1);
  if (last?.kind === 'part' && last.part.type === 'text') {
    segments[segments.length - 1] = {
      kind: 'part',
      part: { type: 'text', text: last.part.text + segment },
    };
    return;
  }
  segments.push({ kind: 'part', part: { type: 'text', text: segment } });
}

function imagePartForAttachment(att: ImageAttachment): PromptPart {
  const base64 = Buffer.from(att.bytes).toString('base64');
  return {
    type: 'image_url',
    imageUrl: { url: `data:${att.mime};base64,${base64}` },
  };
}

function materializeVideoToCache(att: VideoAttachment, escapeProofName = false): string {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  // The label permits XML boundary chars (`<>&"`); plain references go
  // through skill-arg escaping, where they would no longer match the file
  // on disk, so strip them from the cache name in that mode.
  const label = escapeProofName ? att.label.replaceAll(/[<>&"]/g, '_') : att.label;
  const target = join(cacheDir, `${randomUUID()}-${label}`);
  copyFileSync(att.sourcePath, target);
  return target;
}

const IMAGE_MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
};

function materializeImageToCache(att: ImageAttachment): string {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  // ReadMediaFile sniffs the real format from the bytes, so the extension
  // only needs to be a reasonable hint.
  const ext = IMAGE_MIME_EXTENSION[att.mime.trim().toLowerCase()] ?? 'img';
  const target = join(cacheDir, `${randomUUID()}.${ext}`);
  writeFileSync(target, att.bytes);
  return target;
}

function captionForCompressedImage(att: ImageAttachment): string {
  const original = att.original;
  if (original === undefined) return '';
  return buildImageCompressionCaption({
    original: {
      width: original.width,
      height: original.height,
      byteLength: original.byteLength,
      mimeType: original.mime,
    },
    final: {
      width: att.width,
      height: att.height,
      byteLength: att.bytes.length,
      mimeType: att.mime,
    },
    originalPath: original.path,
  });
}

function formatMediaTag(tag: 'image' | 'video', path: string): string {
  return `<${tag} path="${escapeAttribute(path)}"></${tag}>`;
}

/**
 * Plain-text media reference for channels that XML-escape args (`/skill`).
 * Free of `& < > "` (UUID image names; boundary chars stripped from video
 * cache names — see materializeVideoToCache) so it survives
 * `escapeXml`/`escapeXmlTags` untouched.
 */
function formatMediaReference(kind: 'image' | 'video', path: string): string {
  return `Attached ${kind} file: ${path} (open it with ReadMediaFile)`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
