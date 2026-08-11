// packages/app-core/src/lib/codeLanguage.ts
// Maps a file path to a shiki language for syntax highlighting, by extension
// (or a few well-known extensionless filenames). Deliberately shiki-free at
// runtime (a static `import 'shiki'` here would pull the highlighter core into
// the main bundle; the component loads shiki lazily instead) — but the table
// is typed against BundledLanguage, so an unsupported language fails typecheck
// instead of reaching the highlighter.

import type { BundledLanguage } from 'shiki';

// Extension (lowercase, no dot) → shiki language id/alias.
const EXTENSION_LANGUAGES: Record<string, BundledLanguage> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  vue: 'vue',
  svelte: 'svelte',
  py: 'py',
  rb: 'rb',
  go: 'go',
  rs: 'rs',
  java: 'java',
  kt: 'kt',
  kts: 'kts',
  scala: 'scala',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'cs',
  php: 'php',
  sh: 'sh',
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
  ps1: 'ps1',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  graphql: 'graphql',
  prisma: 'prisma',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  ini: 'ini',
  md: 'md',
  markdown: 'markdown',
  mdx: 'mdx',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  zig: 'zig',
  mk: 'makefile',
  cmake: 'cmake',
  diff: 'diff',
  proto: 'proto',
};

const SPECIAL_FILENAMES: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
};

export function codeLanguageFromPath(path: string | undefined): BundledLanguage | undefined {
  const base = path?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!base) return undefined;
  const special = SPECIAL_FILENAMES[base];
  if (special) return special;
  const dot = base.lastIndexOf('.');
  // Extensionless, or a dotfile like `.gitignore` (the "extension" is the name).
  if (dot <= 0) return undefined;
  return EXTENSION_LANGUAGES[base.slice(dot + 1)];
}
