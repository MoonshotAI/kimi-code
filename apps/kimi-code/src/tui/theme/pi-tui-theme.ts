/**
 * Pi-tui theme adapters — MarkdownTheme and EditorTheme backed by the
 * global `currentTheme` singleton.
 *
 * All colour lookups route through `currentTheme.color(token)` so that
 * switching themes is instantaneous: old components hold old
 * MarkdownTheme/EditorTheme instances, but every method call on those
 * instances reads the *current* palette via the singleton.
 */

import type { MarkdownTheme, EditorTheme } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

import { currentTheme } from './theme';
import { codeHighlightTheme } from './highlight-theme';

// pi-tui's renderer emits literal "### " / "#### " / ... markers for h3-h6
// headings (h1/h2 are rendered without the `#` prefix). The prefix arrives
// here already wrapped in bold SGR codes, so we strip it — after any leading
// ANSI sequences — before re-styling. Without this, h3+ renders as raw
// "### Title" and reads like unparsed markdown.
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte that opens ANSI SGR sequences.
const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/;

export function createMarkdownTheme(options?: { transient?: boolean }): MarkdownTheme {
  const transient = options?.transient === true;
  const stripHash = (text: string): string => text.replace(HEADING_HASH_PREFIX, '$1');

  return {
    heading: (text) => chalk.bold.hex(currentTheme.color('text'))(stripHash(text)),
    link: (text) => chalk.hex(currentTheme.color('primary'))(text),
    linkUrl: (text) => chalk.hex(currentTheme.color('textMuted'))(text),
    code: (text) => chalk.hex(currentTheme.color('primary'))(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => chalk.hex(currentTheme.color('textMuted'))(text),
    quote: (text) => chalk.hex(currentTheme.color('textDim'))(text),
    quoteBorder: (text) => chalk.hex(currentTheme.color('textDim'))(text),
    hr: (text) => chalk.hex(currentTheme.color('border'))(text),
    // Match the assistant-message bullet so list markers read like a reply
    // prefix. Ordered lists arrive as "1. " / "2. " and are left
    // untouched by the leading-dash anchor.
    listBullet: (text) => chalk.hex(currentTheme.color('text'))(text.replace(/^-/, '•')),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code: string, lang?: string) => {
      if (transient) return code.split('\n');

      const normalizedLang = lang?.trim().toLowerCase();
      const language =
        normalizedLang !== undefined && supportsLanguage(normalizedLang) ? normalizedLang : 'text';
      try {
        const highlighted = highlight(code, { language, ignoreIllegals: true, theme: codeHighlightTheme });
        return highlighted.split('\n');
      } catch {
        return code.split('\n');
      }
    },
  };
}

export function createEditorTheme(): EditorTheme {
  return {
    borderColor: (s) => chalk.hex(currentTheme.color('border'))(s),
    selectList: {
      selectedPrefix: (s) => chalk.hex(currentTheme.color('primary'))(s),
      selectedText: (s) => chalk.hex(currentTheme.color('primary'))(s),
      description: (s) => chalk.hex(currentTheme.color('textMuted'))(s),
      scrollInfo: (s) => chalk.hex(currentTheme.color('textMuted'))(s),
      noMatch: (s) => chalk.hex(currentTheme.color('textMuted'))(s),
    },
  };
}
