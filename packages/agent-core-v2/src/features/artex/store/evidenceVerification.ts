import { brotliDecompress, gunzip, inflate, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliAsync = promisify(brotliDecompress);
const inflateRawAsync = promisify(inflateRaw);

export const ARTEX_VERIFICATION_READ_CAP = 4 * 1024 * 1024;
export const ARTEX_VERIFICATION_MIN_QUOTE_RUNES = 8;

export type ArtexVerificationQuoteStatus = 'found' | 'not_found' | 'not_assessed' | 'blocked';

export interface ArtexVerificationQuoteResult {
  readonly status: ArtexVerificationQuoteStatus;
  readonly trafficId?: string;
  readonly note?: string;
}

export function normalizeEvidenceText(value: string): string {
  return value.trim().split(/\s+/).filter((part) => part.length > 0).join(' ');
}

function contentEncodings(respHead: string): readonly string[] {
  const out: string[] = [];
  for (const line of respHead.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== 'content-encoding') continue;
    const value = line.slice(colon + 1);
    for (const part of value.split(',')) {
      const enc = part.trim().toLowerCase();
      if (enc === '' || enc === 'identity') continue;
      out.push(enc);
    }
  }
  return out;
}

async function decodeLayer(encoding: string, raw: Buffer): Promise<Buffer> {
  switch (encoding) {
    case 'gzip':
      return gunzipAsync(raw);
    case 'deflate': {
      try {
        return await inflateAsync(raw);
      } catch {
        return inflateRawAsync(raw);
      }
    }
    case 'br':
      return brotliAsync(raw);
    default:
      throw new Error(`unsupported content-encoding: ${encoding}`);
  }
}

export async function decodeEvidenceBody(
  respHead: string,
  raw: Buffer,
  limit: number = ARTEX_VERIFICATION_READ_CAP,
): Promise<{ readonly body: Buffer; readonly truncated: boolean }> {
  let current = raw.length > limit ? raw.subarray(0, limit) : raw;
  let truncated = raw.length > limit;
  const encodings = contentEncodings(respHead);
  if (encodings.length > 1) {
    throw new Error('unsupported content-encoding: more than one compressed layer');
  }
  const encoding = encodings[0];
  if (encoding !== undefined) {
    current = await decodeLayer(encoding, current);
    if (current.length > limit) {
      current = current.subarray(0, limit);
      truncated = true;
    }
  }
  return { body: current, truncated };
}

export function quoteMeetsMinRunes(quote: string): boolean {
  const normalized = normalizeEvidenceText(quote);
  return normalized.replaceAll(/\s/g, '').length >= ARTEX_VERIFICATION_MIN_QUOTE_RUNES;
}

export function isBinaryBody(body: Buffer): boolean {
  if (body.length === 0) return false;
  if (body.includes(0)) return true;
  try {
    const text = body.toString('utf8');
    return text !== body.toString('latin1');
  } catch {
    return true;
  }
}

export function quoteInResponseText(normalizedBody: string, quote: string): boolean {
  const normalizedQuote = normalizeEvidenceText(quote);
  if (normalizedQuote.replaceAll(/\s/g, '').length < ARTEX_VERIFICATION_MIN_QUOTE_RUNES) return false;
  return normalizeEvidenceText(normalizedBody).includes(normalizedQuote);
}