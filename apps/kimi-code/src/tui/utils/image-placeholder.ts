/**
 * Scan submitted text for media placeholders and produce
 * the `PromptPart[]` we'll send to the SDK prompt endpoint.
 *
 * Rules:
 *   - Only placeholders that resolve against `store` get extracted.
 *     A literal `[image #999 ...]` the user typed themselves stays in
 *     the text (we can't hallucinate files for it).
 *   - Order is preserved for text/image/video segments. Image placeholders
 *     expand to image content parts when the model can see images. For
 *     text-only models they can instead expand to file-path tags, matching
 *     the video path flow.
 *   - Adjacent text segments are flattened — empty / whitespace-only
 *     segments drop out so we never emit `{type:'text', text:' '}`
 *     noise between two media parts.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type {
  ImageAttachment,
  ImageAttachmentStore,
  VideoAttachment,
} from './image-attachment-store';

const PLACEHOLDER_REGEX = /\[(image|video) #(\d+) (?:(\(\d+×\d+\))|([^\]]+))\]/g;
const PASTED_IMAGE_DIR_PREFIX = join(tmpdir(), 'kimi-code-pasted-images-');
let pastedImageDir: string | undefined;

export type ImageExtractionMode = 'content-part' | 'file-tag';

export interface ExtractionOptions {
  readonly imageMode?: ImageExtractionMode;
  readonly writeImageAttachment?: (attachment: ImageAttachment) => string;
}

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
  options?: ExtractionOptions,
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
      const mediaText = tagTextForVideo(attachment);
      pushText(parts, mediaText);
      videoAttachmentIds.push(id);
    } else {
      if ((options?.imageMode ?? 'content-part') === 'file-tag') {
        pushText(parts, tagTextForImage(attachment, options));
      } else {
        parts.push(imagePartForAttachment(attachment));
      }
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

function tagTextForVideo(att: VideoAttachment): string {
  return formatMediaTag('video', att.sourcePath);
}

function tagTextForImage(att: ImageAttachment, options: ExtractionOptions | undefined): string {
  const path = options?.writeImageAttachment?.(att) ?? writeImageAttachmentToTempFile(att);
  return formatMediaTag('image', path);
}

function formatMediaTag(tag: 'image' | 'video', path: string): string {
  return `<${tag} path="${escapeAttribute(path)}"></${tag}>`;
}

function writeImageAttachmentToTempFile(att: ImageAttachment): string {
  const path = join(
    getPastedImageDir(),
    `pasted-${String(Date.now())}-${String(att.id)}-${randomUUID()}${extensionForMime(att.mime)}`,
  );
  writeFileSync(path, att.bytes, { mode: 0o600 });
  return path;
}

function getPastedImageDir(): string {
  pastedImageDir ??= mkdtempSync(PASTED_IMAGE_DIR_PREFIX);
  return pastedImageDir;
}

function extensionForMime(mime: string): string {
  const [type] = mime.toLowerCase().split(';', 1);
  switch (type ?? '') {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    case 'image/heic':
      return '.heic';
    case 'image/heif':
      return '.heif';
    default:
      return '.img';
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
