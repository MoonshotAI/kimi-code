/**
 * Scan submitted text for media placeholders and produce the prompt content
 * we'll send to the SDK prompt endpoint.
 *
 * `extractMediaAttachments` (sync) is the single expansion path for prompts:
 *   - image placeholders expand to inline image content parts (preceded by a
 *     compression caption when paste-time compression shrank the bytes — see
 *     `ImageAttachment.original`);
 *   - video placeholders are copied into the shared cache (`getCacheDir()`)
 *     and expand to a `video_url` part pointing at the cache copy with a
 *     `file://` url. The v1 engine resolves that local reference inside the
 *     turn — uploading it (the `ms://` inline form) or degrading to a
 *     `<video path>` tag the model reads with `ReadMediaFile` — before the
 *     prompt lands in history.
 *
 * `rewriteMediaPlaceholders` is the separate text channel for slash-command
 * args (`/skill`, plugin commands): those are plain text, so media is rendered
 * as a `<video|image path="…">` tag / plain-text reference into cache-dir
 * copies the model opens with `ReadMediaFile`.
 *
 * Rules for both:
 *   - Only placeholders that resolve against `store` get extracted.
 *     A literal `[image #999 ...]` the user typed themselves stays in
 *     the text (we can't hallucinate files for it).
 *   - Order is preserved for text/image/video segments.
 *   - Adjacent text segments are flattened — empty / whitespace-only
 *     segments drop out so we never emit `{type:'text', text:' '}`
 *     noise between two media parts.
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
      // Copy the paste into the shared cache and reference it by a `file://`
      // url; the engine resolves (uploads or degrades) it inside the turn.
      const cachePath = materializeVideoToCache(attachment);
      parts.push(videoPartForCachePath(cachePath));
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

function imagePartForAttachment(att: ImageAttachment): PromptPart {
  const base64 = Buffer.from(att.bytes).toString('base64');
  return {
    type: 'image_url',
    imageUrl: { url: `data:${att.mime};base64,${base64}` },
  };
}

/**
 * A `video_url` prompt part pointing at a cache copy by `file://` url. The v1
 * engine resolves the local reference in-turn (upload → `ms://`, or degrade to
 * a `<video path>` tag) before it reaches the model or the persisted history.
 */
function videoPartForCachePath(cachePath: string): PromptPart {
  return {
    type: 'video_url',
    videoUrl: { url: pathToFileURL(cachePath).href },
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
