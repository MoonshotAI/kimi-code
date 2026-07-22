/**
 * Shared syntax-highlighting helpers for code previews
 * (tool-call Write/Edit, approval-panel Write content, etc.).
 */

import { extname } from 'node:path';

import { highlight, supportsLanguage } from 'cli-highlight';

import { codeHighlightTheme } from '#/tui/theme/highlight-theme';

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

export function langFromPath(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext.length === 0) return undefined;
  const lang = EXT_LANG_MAP[ext] ?? ext;
  return supportsLanguage(lang) ? lang : undefined;
}

export function highlightLines(code: string, lang: string | undefined): string[] {
  const normalizedLang = lang?.trim().toLowerCase();
  if (!normalizedLang || !supportsLanguage(normalizedLang)) return code.split('\n');
  try {
    return highlight(code, { language: normalizedLang, ignoreIllegals: true, theme: codeHighlightTheme }).split('\n');
  } catch {
    return code.split('\n');
  }
}
