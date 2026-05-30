/**
 * Pi-tui theme adapters — MarkdownTheme and EditorTheme from our ColorPalette.
 *
 * All chalk calls route through `ColorPalette` tokens so themes flip
 * cleanly. No raw `chalk.gray` / `chalk.dim` / `chalk.white` here.
 */

import type { MarkdownTheme, EditorTheme } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

import type { ColorPalette } from './colors';

// pi-tui's renderer emits literal "### " / "#### " / ... markers for h3-h6
// headings (h1/h2 are rendered without the `#` prefix). The prefix arrives
// here already wrapped in bold SGR codes, so we strip it — after any leading
// ANSI sequences — before re-styling. Without this, h3+ renders as raw
// "### Title" and reads like unparsed markdown.
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte that opens ANSI SGR sequences.
const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/;

export function createMarkdownTheme(colors: ColorPalette): MarkdownTheme {
  const stripHash = (text: string): string => text.replace(HEADING_HASH_PREFIX, '$1');
  const muted = chalk.hex(colors.textMuted);
  const dim = chalk.hex(colors.textDim);
  const border = chalk.hex(colors.border);
  return {
    heading: (text) => chalk.bold.hex(colors.text)(stripHash(text)),
    link: (text) => chalk.hex(colors.primary)(text),
    linkUrl: (text) => muted(text),
    code: (text) => chalk.hex(colors.primary)(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => dim(text),
    quote: (text) => dim(text),
    quoteBorder: (text) => dim(text),
    hr: (text) => border(text),
    // Match the assistant-message bullet so list markers read like a reply
    // prefix. Ordered lists arrive as `"1. "` / `"2. "` and are left
    // untouched by the leading-dash anchor.
    listBullet: (text) => chalk.hex(colors.roleAssistant)(text.replace(/^-/, '•')),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code: string, lang?: string) => {
      const normalizedLang = lang?.trim().toLowerCase();
      const language =
        normalizedLang !== undefined && supportsLanguage(normalizedLang) ? normalizedLang : undefined;
      if (language) {
        try {
          const highlighted = highlight(code, { language, ignoreIllegals: true });
          return highlighted.split('\n');
        } catch {
          // fall through to dim-styled fallback
        }
      }
      return code.split('\n').map((line) => dim(line));
    },
  };
}

export function createEditorTheme(colors: ColorPalette): EditorTheme {
  const muted = chalk.hex(colors.textMuted);
  return {
    borderColor: (s) => chalk.hex(colors.border)(s),
    selectList: {
      selectedPrefix: (s) => chalk.hex(colors.primary)(s),
      selectedText: (s) => chalk.hex(colors.primary)(s),
      description: (s) => muted(s),
      scrollInfo: (s) => muted(s),
      noMatch: (s) => muted(s),
    },
  };
}
