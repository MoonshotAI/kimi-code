import type { MarkdownTheme, EditorTheme } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

import { currentTheme } from './theme';
import { codeHighlightTheme } from './highlight-theme';

const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/;

export interface KimiMarkdownTheme extends MarkdownTheme {
  transient?: boolean;
}

export function createMarkdownTheme(options?: { transient?: boolean }): KimiMarkdownTheme {
  const transient = options?.transient === true;
  const stripHash = (text: string): string => text.replace(HEADING_HASH_PREFIX, '$1');

  return {
    transient,
    heading: (text) => chalk.bold.hex(currentTheme.color('text'))(stripHash(text)),
    link: (text) => chalk.hex(currentTheme.color('primary'))(text),
    linkUrl: (text) => chalk.hex(currentTheme.color('textMuted'))(text),
    code: (text) => chalk.hex(currentTheme.color('primary'))(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => chalk.hex(currentTheme.color('textMuted'))(text),
    quote: (text) => chalk.hex(currentTheme.color('textDim'))(text),
    quoteBorder: (text) => chalk.hex(currentTheme.color('textDim'))(text),
    hr: (text) => chalk.hex(currentTheme.color('border'))(text),
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
