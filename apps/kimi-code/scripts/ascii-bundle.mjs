/**
 * Rewrite a bundled JavaScript file so that every code unit is ASCII.
 *
 * V8 keeps the source text of every script alive for as long as its functions
 * exist (lazy compilation, `Function.prototype.toString`). A source that
 * contains a single character above U+00FF has to be stored as a two-byte
 * string, so the CLI bundle costs two bytes per character of resident memory
 * instead of one, and every scan of it (parsing, lazy compilation) walks the
 * wider representation. A handful of non-ASCII characters in UI strings,
 * prompts and comments is enough to trigger that for the whole bundle.
 *
 * The rewrite is a token-level transformation, not a re-print: acorn's
 * tokenizer locates string, template, regular-expression and identifier
 * tokens plus comments, and only the non-ASCII characters inside them are
 * replaced by `\uXXXX` escapes that denote the same value. Everything else,
 * including formatting, line numbers and the `//#region` markers, is left
 * byte-for-byte as rolldown emitted it, so stack traces and the bundle
 * checks keep working.
 *
 * Deliberately unsupported (the rewrite throws instead of guessing):
 * - non-ASCII text inside a tagged template (`String.raw` and other tags can
 *   observe the raw text, so escaping it would change behaviour);
 * - U+2028 / U+2029 inside a string or template literal (replacing them would
 *   change V8's line numbering for everything below);
 * - non-ASCII characters anywhere else in the code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as acorn from 'acorn';

const CATEGORIES = ['string', 'template', 'regexp', 'identifier', 'comment', 'whitespace'];

// A template literal that directly follows an expression is a tagged template.
const EXPRESSION_END_LABELS = new Set([
  'name',
  'privateId',
  'string',
  'num',
  'regexp',
  ')',
  ']',
  '}',
  '`',
  'this',
  'super',
  'true',
  'false',
  'null',
]);

const LINE_SEPARATORS = new Set([0x2028, 0x2029]);
const UNICODE_WHITESPACE = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

function zeroCounts() {
  return { string: 0, template: 0, regexp: 0, identifier: 0, comment: 0, whitespace: 0 };
}

/** First code unit above U+007F, with a 1-based line and column, or undefined. */
export function firstNonAscii(text) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit > 0x7f) return { index, line, column: index - lineStart + 1, codeUnit };
    if (codeUnit === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return undefined;
}

function unicodeEscape(codeUnit) {
  return `\\u${codeUnit.toString(16).padStart(4, '0')}`;
}

function isEscapedBy(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Escape the non-ASCII code units of one string / template / regexp token.
 * A redundant escaping backslash right before the character (`"\é"`) is
 * dropped, because `"\\u00e9"` would no longer denote the same value.
 */
function escapeLiteral(text, kind, describe) {
  let out = '';
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      out += text[index];
      continue;
    }
    if (LINE_SEPARATORS.has(codeUnit) && kind !== 'regexp') {
      throw new Error(`${describe()}: U+${codeUnit.toString(16)} inside a ${kind} literal is not supported`);
    }
    if (isEscapedBy(text, index)) out = out.slice(0, -1);
    out += unicodeEscape(codeUnit);
    count += 1;
  }
  return { text: out, count };
}

/** Identifiers take `\uXXXX` for BMP characters and `\u{...}` for astral ones. */
function escapeIdentifier(text) {
  let out = '';
  let count = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0x7f) {
      out += char;
      continue;
    }
    out += codePoint > 0xffff ? `\\u{${codePoint.toString(16)}}` : unicodeEscape(codePoint);
    count += char.length;
  }
  return { text: out, count };
}

function escapeComment(text) {
  let out = '';
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      out += text[index];
      continue;
    }
    out += unicodeEscape(codeUnit);
    count += 1;
  }
  return { text: out, count };
}

function collectSpans(source, sourceType) {
  const spans = [];
  const tokenizer = acorn.tokenizer(source, {
    ecmaVersion: 'latest',
    sourceType,
    allowHashBang: true,
    onComment: (_block, _text, start, end) => spans.push({ start, end, kind: 'comment' }),
  });
  const openTemplates = [];
  let previous;
  for (const token of tokenizer) {
    const label = token.type.label;
    if (label === '`') {
      if (previous !== undefined && previous.type.label === 'template') openTemplates.pop();
      else openTemplates.push(previous !== undefined && EXPRESSION_END_LABELS.has(previous.type.label));
    } else if (label === 'template') {
      spans.push({
        start: token.start,
        end: token.end,
        kind: openTemplates.at(-1) === true ? 'tagged-template' : 'template',
      });
    } else if (label === 'string' || label === 'regexp') {
      spans.push({ start: token.start, end: token.end, kind: label });
    } else if (label === 'name' || label === 'privateId') {
      spans.push({ start: token.start, end: token.end, kind: 'identifier' });
    }
    previous = token;
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Returns the ASCII-only text and how many code units were escaped per
 * category. Throws when the source uses a construct the rewrite cannot
 * preserve (see the module comment).
 */
export function escapeNonAscii(source, { sourceType }) {
  const counts = zeroCounts();
  if (firstNonAscii(source) === undefined) return { text: source, counts };

  const lineAt = (index) => {
    let line = 1;
    for (let cursor = 0; cursor < index; cursor += 1) if (source.charCodeAt(cursor) === 0x0a) line += 1;
    return line;
  };
  const parts = [];
  let cursor = 0;
  let lineSeparatorsReplaced = 0;

  const emitGap = (end) => {
    for (let index = cursor; index < end; index += 1) {
      const codeUnit = source.charCodeAt(index);
      if (codeUnit <= 0x7f) {
        parts.push(source[index]);
        continue;
      }
      if (LINE_SEPARATORS.has(codeUnit)) {
        parts.push('\n');
        lineSeparatorsReplaced += 1;
      } else if (UNICODE_WHITESPACE.has(codeUnit)) {
        if (index !== 0) parts.push(' ');
      } else {
        throw new Error(
          `line ${lineAt(index)}: non-ASCII code unit U+${codeUnit.toString(16)} outside any literal or comment`,
        );
      }
      counts.whitespace += 1;
    }
    cursor = end;
  };

  for (const span of collectSpans(source, sourceType)) {
    emitGap(span.start);
    const text = source.slice(span.start, span.end);
    const describe = () => `line ${lineAt(span.start)}`;
    let escaped;
    if (span.kind === 'comment') escaped = escapeComment(text);
    else if (span.kind === 'identifier') escaped = escapeIdentifier(text);
    else if (span.kind === 'tagged-template') {
      if (firstNonAscii(text) !== undefined) {
        throw new Error(`${describe()}: non-ASCII text inside a tagged template cannot be escaped`);
      }
      escaped = { text, count: 0 };
    } else escaped = escapeLiteral(text, span.kind, describe);
    parts.push(escaped.text);
    if (span.kind !== 'tagged-template') counts[span.kind] += escaped.count;
    cursor = span.end;
  }
  emitGap(source.length);

  const text = parts.join('');
  const remaining = firstNonAscii(text);
  if (remaining !== undefined) {
    throw new Error(
      `line ${remaining.line}: code unit U+${remaining.codeUnit.toString(16)} survived the rewrite`,
    );
  }
  const expectedLines = source.split('\n').length + lineSeparatorsReplaced;
  if (text.split('\n').length !== expectedLines) {
    throw new Error('the rewrite changed the number of lines');
  }
  return { text, counts };
}

function sourceTypeFor(path) {
  if (path.endsWith('.mjs')) return 'module';
  if (path.endsWith('.cjs')) return 'script';
  throw new Error(`cannot infer the source type of ${path}; expected a .mjs or .cjs bundle`);
}

/** Rewrite the bundles in place; returns one summary line per file. */
export function rewriteBundles(paths) {
  return paths.map((path) => {
    const source = readFileSync(path, 'utf8');
    const { text, counts } = escapeNonAscii(source, { sourceType: sourceTypeFor(path) });
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total === 0) return `${path}: already ASCII`;
    writeFileSync(path, text);
    const detail = CATEGORIES.filter((category) => counts[category] > 0)
      .map((category) => `${category} ${counts[category]}`)
      .join(', ');
    return `${path}: escaped ${total} non-ASCII code units (${detail})`;
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: ascii-bundle.mjs <bundle.cjs|bundle.mjs> ...');
    process.exit(1);
  }
  for (const line of rewriteBundles(paths)) console.log(`ascii-bundle: ${line}`);
}
