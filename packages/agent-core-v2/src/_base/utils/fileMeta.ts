/**
 * File content metadata helpers — binary detection, line counting, etag, and
 * extension-based mime / language guessing.
 *
 * Shared by the fs edge domains (`sessionFs`) and the kap-server fs routes so
 * every read-style surface classifies and labels file content the same way.
 * Pure functions over bytes, text, and stat-like shapes; no io happens here.
 * Binary detection samples the leading `FS_BINARY_SAMPLE_BYTES` of a file and
 * flags it as binary when the non-printable fraction exceeds
 * `FS_BINARY_NONPRINTABLE_FRACTION`; etags are built from any stat-like shape
 * carrying `size` / `mtimeMs` / `ino` (`FileMetaStat`, satisfied by
 * `HostFileStat`).
 */

import { extname } from 'node:path';

export const FS_BINARY_SAMPLE_BYTES = 4096;
export const FS_BINARY_NONPRINTABLE_FRACTION = 0.3;

export interface FileMetaStat {
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
}

export function detectBinary(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 32 && b <= 126) continue;
    nonPrintable++;
  }
  return nonPrintable / buf.length > FS_BINARY_NONPRINTABLE_FRACTION;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  if (text.charCodeAt(text.length - 1) === 10) n--;
  return Math.max(0, n);
}

export function buildEtag(st: FileMetaStat): string {
  const mtime = Math.floor(st.mtimeMs ?? 0);
  const ino = st.ino ?? 0;
  return [mtime.toString(36), st.size.toString(36), ino.toString(36)].join('-');
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'application/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/rust',
  '.go': 'text/x-go',
};

export function guessMime(path: string, isBinary: boolean): string {
  const ext = extname(path).toLowerCase();
  const mapped = EXT_TO_MIME[ext];
  if (mapped !== undefined) return mapped;
  return isBinary ? 'application/octet-stream' : 'text/plain';
}

const EXT_TO_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shellscript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

export function guessLanguageId(path: string): string | undefined {
  return EXT_TO_LANGUAGE[extname(path).toLowerCase()];
}
