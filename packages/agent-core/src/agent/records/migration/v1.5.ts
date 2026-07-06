/**
 * 1.4 → 1.5: tool-produced `<system>` metadata moves out of tool-result
 * `output` into the structured `note` side channel.
 *
 * Through 1.4, ReadMediaFile / Read / the MCP image-compression pipeline
 * baked their model-facing metadata into the output text as `<system>…`
 * blocks, which every UI then had to strip back out. 1.5 stores that
 * metadata as `result.note` (rendered to the model at projection time,
 * never to UIs), so old records are rewritten to the same shape.
 *
 * Only blocks that anchor on the exact openings those three producers used
 * are moved; any other `<system>` text is user data and stays untouched.
 */
import { extractImageCompressionCaptions } from '../../../tools/support/image-compress';
import type { WireMigration, WireMigrationRecord } from './index';

/** Entire-part match for the ReadMediaFile summary (was the first part). */
const READ_MEDIA_NOTE_RE = /^<system>Read (?:image|video) file\. Mime type: [\s\S]*<\/system>$/;

/** Trailing Read status block, matching `finishMessage`'s fixed openings. */
const READ_STATUS_TAIL_RE =
  /\n?<system>(?:\d+ lines? read from file starting from line \d+\.|No lines read from file\.) Total lines in file: \d+\.[\s\S]*?<\/system>$/;

interface LoosePart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly [key: string]: unknown;
}

interface LooseToolResult {
  readonly output?: unknown;
  readonly note?: unknown;
  readonly [key: string]: unknown;
}

interface LooseToolResultEvent {
  readonly type?: unknown;
  readonly result?: unknown;
  readonly [key: string]: unknown;
}

export const migrateV1_4ToV1_5: WireMigration = {
  sourceVersion: '1.4',
  targetVersion: '1.5',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'context.append_loop_event') return record;
    const event = record['event'] as LooseToolResultEvent | undefined;
    if (event === undefined || event.type !== 'tool.result') return record;
    const result = event.result as LooseToolResult | undefined;
    if (result === undefined || result === null || typeof result !== 'object') return record;
    if (typeof result.note === 'string') return record;

    const extracted = extractToolNote(result.output);
    if (extracted === null) return record;

    return {
      ...record,
      event: {
        ...event,
        result: { ...result, output: extracted.output, note: extracted.note },
      },
    };
  },
};

function extractToolNote(
  output: unknown,
): { output: string | LoosePart[]; note: string } | null {
  if (typeof output === 'string') return extractFromString(output);
  if (Array.isArray(output)) return extractFromParts(output as LoosePart[]);
  return null;
}

function extractFromString(output: string): { output: string; note: string } | null {
  const notes: string[] = [];

  const captioned = extractImageCompressionCaptions(output);
  let remainder = captioned.text;
  notes.push(...captioned.captions.map((body) => `<system>${body}</system>`));

  const statusMatch = READ_STATUS_TAIL_RE.exec(remainder);
  if (statusMatch !== null) {
    remainder = remainder.slice(0, statusMatch.index);
    notes.push(statusMatch[0].startsWith('\n') ? statusMatch[0].slice(1) : statusMatch[0]);
  }

  if (notes.length === 0) return null;
  return { output: remainder, note: notes.join('\n') };
}

function extractFromParts(parts: LoosePart[]): { output: LoosePart[]; note: string } | null {
  const kept: LoosePart[] = [];
  const notes: string[] = [];
  for (const part of parts) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      if (READ_MEDIA_NOTE_RE.test(part.text)) {
        notes.push(part.text);
        continue;
      }
      const captioned = extractImageCompressionCaptions(part.text);
      if (captioned.captions.length > 0) {
        notes.push(...captioned.captions.map((body) => `<system>${body}</system>`));
        if (captioned.text.trim().length > 0) {
          kept.push({ ...part, text: captioned.text });
        }
        continue;
      }
    }
    kept.push(part);
  }
  if (notes.length === 0) return null;
  return { output: kept, note: notes.join('\n') };
}
