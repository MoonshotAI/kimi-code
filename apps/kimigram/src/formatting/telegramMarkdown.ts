const TELEGRAM_RESERVED = new Set(
  '_*[]()~`>#+-=|{}.!'.split('')
);

const MARKDOWN_ESCAPABLE = new Set(
  '\\`*_{}[]()#+-.!|=~'.split('')
);

type Span = 'bold' | 'italic' | 'strike' | 'code' | 'link';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface TelegramMarkdownResult {
  /** The message text to send. */
  text: string;
  /**
   * When present, Telegram should parse the text as MarkdownV2.
   * When absent, the text must be sent as plain text (used for malformed
   * input or when truncation would break MarkdownV2 entities).
   */
  parseMode?: 'MarkdownV2';
}

/**
 * Converts kimi-code Markdown into Telegram MarkdownV2.
 *
 * Returns `{ parseMode: 'MarkdownV2' }` when conversion succeeds. If the input
 * is malformed, cannot be safely converted, or would exceed Telegram's message
 * length limit, the original text (truncated when necessary) is returned
 * without a parse mode so Telegram treats it as plain text.
 */
export function convertToTelegramMarkdown(
  input: string
): TelegramMarkdownResult {
  if (input.length === 0) {
    return { text: '' };
  }

  try {
    let text = parseBlocks(input.replace(/\r\n/g, '\n'));
    if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      // Truncating MarkdownV2 can leave unclosed entities. Fall back to a
      // truncated plain-text version of the original input so Telegram never
      // receives malformed markup.
      return {
        text: input.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 3) + '...',
      };
    }
    return { text, parseMode: 'MarkdownV2' };
  } catch {
    let text = input;
    if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      text = text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 3) + '...';
    }
    return { text };
  }
}

function parseBlocks(raw: string): string {
  const lines = raw.split('\n');
  let output = '';
  let inCodeBlock = false;
  let codeLanguage = '';
  const codeLines: string[] = [];

  for (const line of lines) {
    if (inCodeBlock) {
      if (isCodeFence(line)) {
        output +=
          '```' +
          codeLanguage +
          '\n' +
          codeLines.join('\n') +
          '\n```\n';
        inCodeBlock = false;
        codeLines.length = 0;
        codeLanguage = '';
      } else {
        codeLines.push(escapeCode(line));
      }
      continue;
    }

    const trimmed = line.trimStart();

    const fenceMatch = line.match(/^ {0,3}```(.*)$/);
    if (fenceMatch) {
      codeLanguage = fenceMatch[1].trim();
      inCodeBlock = true;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})(?:\s+|$)(.*)$/);
    if (headingMatch) {
      const content = headingMatch[2].trimStart();
      output += '*' + parseInline(content) + '*\n';
      continue;
    }

    if (/^[-*+]\s/.test(trimmed)) {
      const marker = trimmed[0];
      const content = trimmed.slice(2);
      output += '\\' + marker + ' ' + parseInline(content) + '\n';
      continue;
    }

    const numberedMatch = /^\d+\.\s(.*)$/.exec(trimmed);
    if (numberedMatch) {
      const number = trimmed.slice(0, trimmed.indexOf('.') + 1);
      output += number.slice(0, -1) + '\\. ' + parseInline(numberedMatch[1]) + '\n';
      continue;
    }

    if (trimmed.startsWith('>')) {
      output += '\\> ' + parseInline(trimmed.slice(1).trimStart()) + '\n';
      continue;
    }

    output += parseInline(line) + '\n';
  }

  if (inCodeBlock) {
    throw new Error('unclosed code block');
  }

  return output.trimEnd();
}

function parseInline(input: string, active: Set<Span> = new Set()): string {
  let output = '';
  let i = 0;

  while (i < input.length) {
    if (input.startsWith('![', i) && active.size === 0) {
      const closeBracket = findUnescaped(input, i + 2, '](');
      if (closeBracket !== -1) {
        const urlStart = closeBracket + 2;
        const closeParen = findMatchingCloseParen(input, urlStart);
        if (closeParen !== -1) {
          const alt = input.slice(i + 2, closeBracket);
          output +=
            '📎 ' + parseInline(alt, withActive(active, 'link'));
          i = closeParen + 1;
          continue;
        }
        throw new Error('unclosed image link');
      }
      output += escapeChar('!');
      i++;
      continue;
    }

    if (input[i] === '[' && active.size === 0) {
      const closeBracket = findUnescaped(input, i + 1, '](');
      if (closeBracket !== -1) {
        const urlStart = closeBracket + 2;
        const closeParen = findMatchingCloseParen(input, urlStart);
        if (closeParen !== -1) {
          const label = input.slice(i + 1, closeBracket);
          const url = prepareUrl(input.slice(urlStart, closeParen));
          output +=
            '[' +
            parseInline(label, withActive(active, 'link')) +
            '](' +
            url +
            ')';
          i = closeParen + 1;
          continue;
        }
        throw new Error('unclosed link');
      }
      output += escapeChar('[');
      i++;
      continue;
    }

    if (input[i] === '`' && active.size === 0) {
      const end = findBacktickClose(input, i + 1);
      if (end === -1) {
        throw new Error('unclosed inline code');
      }
      output += '`' + escapeCode(input.slice(i + 1, end)) + '`';
      i = end + 1;
      continue;
    }

    if (input.startsWith('**', i) && active.size === 0) {
      const end = findUnescaped(input, i + 2, '**');
      if (end === -1) {
        throw new Error('unclosed bold');
      }
      output +=
        '*' +
        parseInline(input.slice(i + 2, end), withActive(active, 'bold')) +
        '*';
      i = end + 2;
      continue;
    }

    if (input[i] === '*' && active.size === 0) {
      const end = findSingleAsteriskClose(input, i + 1);
      if (end === -1) {
        throw new Error('unclosed italic');
      }
      output +=
        '_' +
        parseInline(input.slice(i + 1, end), withActive(active, 'italic')) +
        '_';
      i = end + 1;
      continue;
    }

    if (input.startsWith('__', i) && active.size === 0) {
      const end = findDoubleUnderscoreClose(input, i + 2);
      if (end === -1) {
        throw new Error('unclosed double underscore bold');
      }
      output +=
        '*' +
        parseInline(input.slice(i + 2, end), withActive(active, 'bold')) +
        '*';
      i = end + 2;
      continue;
    }

    if (input[i] === '_' && active.size === 0) {
      if (isValidUnderscoreOpen(input, i)) {
        const end = findUnderscoreClose(input, i + 1);
        if (end === -1) {
          throw new Error('unclosed underscore italic');
        }
        output +=
          '_' +
          parseInline(input.slice(i + 1, end), withActive(active, 'italic')) +
          '_';
        i = end + 1;
        continue;
      }
      output += escapeChar('_');
      i++;
      continue;
    }

    if (input.startsWith('~~', i) && active.size === 0) {
      const end = findUnescaped(input, i + 2, '~~');
      if (end === -1) {
        throw new Error('unclosed strikethrough');
      }
      output +=
        '~' +
        parseInline(input.slice(i + 2, end), withActive(active, 'strike')) +
        '~';
      i = end + 2;
      continue;
    }

    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length && MARKDOWN_ESCAPABLE.has(input[i + 1])) {
      output += escapeChar(input[i + 1]);
      i += 2;
      continue;
    }

    output += escapeChar(ch);
    i++;
  }

  return output;
}

function withActive(active: Set<Span>, span: Span): Set<Span> {
  const next = new Set(active);
  next.add(span);
  return next;
}

function escapeChar(ch: string): string {
  if (TELEGRAM_RESERVED.has(ch)) {
    return '\\' + ch;
  }
  return ch;
}

function escapeCode(content: string): string {
  return content.replace(/([\\`])/g, '\\$1');
}

function prepareUrl(url: string): string {
  // First undo Markdown backslash escapes inside the URL (any backslash before a
  // non-word character), then apply Telegram escaping for the characters that
  // would break the link syntax.
  return url
    .replace(/\\(\W)/g, '$1')
    .replace(/\\/g, '\\\\')
    .replace(/\)/g, '\\)')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function findUnescaped(input: string, start: number, delim: string): number {
  for (let i = start; i <= input.length - delim.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input.slice(i, i + delim.length) === delim) {
      return i;
    }
  }
  return -1;
}

function findBacktickClose(input: string, start: number): number {
  // Inside inline code, CommonMark does not allow backslash escapes; the next
  // literal backtick always closes the span.
  const index = input.indexOf('`', start);
  return index === -1 ? -1 : index;
}

function findSingleAsteriskClose(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === '*' && input[i + 1] !== '*') {
      return i;
    }
  }
  return -1;
}

function isCodeFence(line: string): boolean {
  // A fenced code block marker is recognized with up to three leading spaces.
  // More indentation means it is content inside the block, not a closing fence.
  return /^ {0,3}```/.test(line);
}

function findMatchingCloseParen(input: string, start: number): number {
  // The caller has already consumed the opening '(' of the link URL.
  // Walk forward tracking nested parentheses so URLs like path(a)b work.
  let depth = 1;
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === '(') {
      depth++;
    } else if (input[i] === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function isValidUnderscoreOpen(input: string, pos: number): boolean {
  if (input[pos] !== '_') return false;
  // Do not treat underscores inside words (e.g. snake_case) as emphasis.
  if (pos > 0 && /[A-Za-z0-9]/.test(input[pos - 1])) return false;
  if (/\s/.test(input[pos + 1] ?? ' ')) return false;
  if (input[pos + 1] === '_') return false;
  return true;
}

function findDoubleUnderscoreClose(input: string, start: number): number {
  for (let i = start; i <= input.length - 2; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === '_' && input[i + 1] === '_') {
      // Avoid matching the center of a ___ run.
      if (input[i - 1] !== '_' && input[i + 2] !== '_') {
        return i;
      }
    }
  }
  return -1;
}

function findUnderscoreClose(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] !== '_') continue;
    // Avoid __ constructs and word-internal underscores.
    if (input[i - 1] === '_') continue;
    if (input[i + 1] === '_') continue;
    if (/\s/.test(input[i - 1] ?? '')) continue;
    if (/[A-Za-z0-9]/.test(input[i + 1] ?? '')) continue;
    return i;
  }
  return -1;
}
