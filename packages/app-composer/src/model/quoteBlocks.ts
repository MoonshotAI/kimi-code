import { parseAttachmentLinks, parseMentionLinks, parseQuoteLinks } from './inlineLinks';
import { serializeQuote, type QuoteAttrs } from './wireCodec';
export let SELECTION_QUOTE_ENABLED = true;

export function setSelectionQuoteEnabledForTests(value: boolean): void {
  SELECTION_QUOTE_ENABLED = value;
}

export type ComposerTextBlock =
  |
    { type: 'quote'; text: string; source?: string; comment?: string; commentSep?: string }
  |
    { type: 'inline'; text: string }
  |
    { type: 'sep'; text: string };

const QUOTE_LINE = /^> (.*)$/;
const QUOTE_EMPTY_LINE = /^>$/;

export function encodeQuoteSourceHeader(source: string): string {
  return source.replaceAll('%', '%25').replaceAll('\n', '%0A').replaceAll('\r', '%0D');
}

export function decodeQuoteSourceHeader(encoded: string): string {
  return encoded.replaceAll('%0A', '\n').replaceAll('%0D', '\r').replaceAll('%25', '%');
}

const QUOTE_SOURCE_LINE = /^from: (.+)$/;

function quoteBlockContent(chunk: string): { text: string; source?: string } | null {
  let body = chunk;
  let source: string | undefined;
  const firstBreak = chunk.indexOf('\n');
  const sourceMatch = QUOTE_SOURCE_LINE.exec(firstBreak === -1 ? chunk : chunk.slice(0, firstBreak));
  if (sourceMatch !== null) {
    source = decodeQuoteSourceHeader(sourceMatch[1]!);
    body = firstBreak === -1 ? '' : chunk.slice(firstBreak + 1);
  }
  const contents: string[] = [];
  for (const line of body.split('\n')) {
    const match = QUOTE_LINE.exec(line);
    if (match !== null) {
      contents.push(match[1] ?? '');
      continue;
    }
    if (QUOTE_EMPTY_LINE.test(line)) {
      contents.push('');
      continue;
    }
    return null;
  }
  return { text: contents.join('\n'), ...(source !== undefined ? { source } : {}) };
}

export function splitQuoteBlocks(text: string): ComposerTextBlock[] {
  const raw: ComposerTextBlock[] = [];
  for (const part of text.split(/(\n{2,})/)) {
    if (part === '') continue;
    if (/^\n{2,}$/.test(part)) {
      raw.push({ type: 'sep', text: part });
      continue;
    }
    const quote = SELECTION_QUOTE_ENABLED ? quoteBlockContent(part) : null;
    raw.push(quote === null ? { type: 'inline', text: part } : { type: 'quote', text: quote.text, ...(quote.source !== undefined ? { source: quote.source } : {}) });
  }
  const blocks: ComposerTextBlock[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const block = raw[i]!;
    if (
      block.type === 'quote' &&
      raw[i + 1]?.type === 'sep' &&
      (raw[i + 1] as { type: 'sep'; text: string }).text === '\n\n' &&
      raw[i + 2]?.type === 'inline' &&
      isPlainCommentChunk((raw[i + 2] as { type: 'inline'; text: string }).text)
    ) {
      const sep = (raw[i + 1] as { type: 'sep'; text: string }).text;
      const comment = (raw[i + 2] as { type: 'inline'; text: string }).text;
      blocks.push({ ...block, comment, commentSep: sep });
      i += 2;
      continue;
    }
    blocks.push(block);
  }
  return blocks;
}

function isPlainCommentChunk(chunk: string): boolean {
  return parseMentionLinks(chunk).length === 0 && parseAttachmentLinks(chunk).length === 0 && parseQuoteLinks(chunk).length === 0;
}

export function buildQuoteWireLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function padQuoteBlockSuffixes(text: string): string {
  if (!SELECTION_QUOTE_ENABLED) return text;
  const parts = text.split(/(\n{2,})/);

  const hasContentAfter: boolean[] = new Array<boolean>(parts.length).fill(false);
  let seenContent = false;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    hasContentAfter[i] = seenContent;
    const part = parts[i]!;
    if (part !== '' && !/^\n{2,}$/.test(part)) seenContent = true;
  }
  let out = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '') continue;
    if (/^\n{2,}$/.test(part)) {
      const prev = parts[i - 1] ?? '';
      out += hasContentAfter[i] && part.length < 3 && quoteBlockContent(prev) !== null ? '\n\n\n' : part;
      continue;
    }
    out += part;
  }
  return out;
}

export function reviveQuoteBlockLinks(text: string): string {
  const blocks = splitQuoteBlocks(text);
  const foldSep = new Set<number>();
  blocks.forEach((block, i) => {
    if (
      block.type === 'sep' &&
      block.text === '\n\n' &&
      blocks[i - 1]?.type === 'quote' &&
      blocks[i + 1]?.type === 'quote'
    ) {
      foldSep.add(i);
    }
  });
  return blocks
    .map((block, i) => {
      if (foldSep.has(i)) return ' ';
      if (block.type !== 'quote') return block.text;
      const attrs: QuoteAttrs = { text: block.text };
      if (block.source !== undefined) attrs.source = block.source;
      if (block.comment !== undefined) attrs.comment = block.comment;
      return serializeQuote(attrs);
    })
    .join('');
}
