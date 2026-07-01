/**
 * ReadMediaFile renderer.
 *
 * The ReadMediaFile tool `output` is the JSON-serialized array of
 * content parts the tool returned — which includes the full base64 of
 * the image/video. Dumping that string into the transcript blasts a
 * multi-screen blob of base64. This renderer parses the envelope and
 * surfaces just the human-readable bits (kind, path, mime, size) via
 * a header chip + a tiny expanded body. It never emits the base64.
 *
 * On error, or when the output isn't the expected media envelope, we
 * fall back to the truncated renderer so the user still sees the raw
 * message.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { Text } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import type { ChipProvider } from './chip';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

export interface ReadMediaSummary {
  kind: 'image' | 'video';
  path?: string;
  mimeType?: string;
  bytes?: number;
  url?: string;
  originalSize?: string;
}

const PATH_TAG_RE = /^<(image|video)\s+path="([^"]+)">$/;
const ORIGINAL_SIZE_RE = /original size\s+(\d+x\d+px)/;
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;

function bytesFromBase64(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

export function parseReadMediaOutput(output: string): ReadMediaSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  let kind: 'image' | 'video' | undefined;
  let path: string | undefined;
  let mimeType: string | undefined;
  let bytes: number | undefined;
  let url: string | undefined;
  let originalSize: string | undefined;
  let foundMedia = false;

  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const part = raw as Record<string, unknown>;
    const type = part['type'];

    if (type === 'text' && typeof part['text'] === 'string') {
      const text = part['text'];
      const tag = PATH_TAG_RE.exec(text);
      if (tag) {
        kind = tag[1] as 'image' | 'video';
        path = tag[2];
        continue;
      }
      const size = ORIGINAL_SIZE_RE.exec(text);
      if (size) originalSize = size[1];
      continue;
    }

    if (type === 'image_url' || type === 'video_url') {
      foundMedia = true;
      kind = type === 'image_url' ? 'image' : 'video';
      const holder = part[type === 'image_url' ? 'imageUrl' : 'videoUrl'];
      if (typeof holder === 'object' && holder !== null) {
        const h = holder as Record<string, unknown>;
        const u = h['url'];
        if (typeof u === 'string') {
          const data = DATA_URL_RE.exec(u);
          if (data && data[1] !== undefined && data[2] !== undefined) {
            mimeType = data[1];
            bytes = bytesFromBase64(data[2]);
          } else {
            url = u;
          }
        }
      }
    }
  }

  if (!foundMedia || kind === undefined) return null;

  const summary: ReadMediaSummary = { kind };
  if (path !== undefined) summary.path = path;
  if (mimeType !== undefined) summary.mimeType = mimeType;
  if (bytes !== undefined) summary.bytes = bytes;
  if (url !== undefined) summary.url = url;
  if (originalSize !== undefined) summary.originalSize = originalSize;
  return summary;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function metaSegments(summary: ReadMediaSummary): string[] {
  const segs: string[] = [];
  if (summary.mimeType !== undefined) segs.push(summary.mimeType);
  if (summary.bytes !== undefined) segs.push(formatBytes(summary.bytes));
  if (summary.originalSize !== undefined) segs.push(summary.originalSize);
  return segs;
}

export const readMediaChip: ChipProvider = (_toolCall, result) => {
  if (result.is_error) return '';
  const summary = parseReadMediaOutput(result.output);
  if (summary === null) return '';
  const meta = metaSegments(summary);
  if (meta.length === 0) {
    return summary.url !== undefined ? `${summary.kind} · uploaded` : summary.kind;
  }
  return `${summary.kind} (${meta.join(', ')})`;
};

export const readMediaSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);
  const summary = parseReadMediaOutput(result.output);
  if (summary === null) return renderTruncated(toolCall, result, ctx);
  if (!ctx.expanded) return [];

  const dim = chalk.dim;
  const out: Component[] = [];
  if (summary.path !== undefined) {
    out.push(new Text(`  ${dim(summary.path)}`, 0, 0));
  }
  const meta = metaSegments(summary);
  const tail: string[] = [summary.kind];
  if (meta.length > 0) tail.push(meta.join(', '));
  if (summary.url !== undefined) tail.push(summary.url);
  out.push(new Text(`  ${dim(tail.join(' · '))}`, 0, 0));
  return out;
};
