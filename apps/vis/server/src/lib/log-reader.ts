import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { LogLine } from './agent-record-types';

const MAX_LINES = 20_000;

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([A-Za-z]+)\s+(.*)$/;
const FIELD_START_RE = /(^|\s)[A-Za-z_][\w.-]*=/;
const FIELD_RE = /([A-Za-z_][\w.-]*)=(\S+)/g;

export interface LogReadResult {
  lines: LogLine[];
  truncated: boolean;
}

export async function discoverLogFiles(baseLogPath: string): Promise<string[]> {
  const dir = dirname(baseLogPath);
  const base = basename(baseLogPath);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
  let hasActive = false;
  const rotated: { n: number; name: string }[] = [];
  const prefix = `${base}.`;
  for (const name of names) {
    if (name === base) {
      hasActive = true;
      continue;
    }
    if (name.startsWith(prefix)) {
      const suffix = name.slice(prefix.length);
      if (/^\d+$/.test(suffix)) rotated.push({ n: Number(suffix), name });
    }
  }
  rotated.sort((a, b) => b.n - a.n);
  const ordered = rotated.map((r) => join(dir, r.name));
  if (hasActive) ordered.push(join(dir, base));
  return ordered;
}

export async function readLogs(
  paths: readonly string[],
  maxLines = MAX_LINES,
): Promise<LogReadResult | null> {
  const allLines: string[] = [];
  let read = 0;
  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    read += 1;
    const lines = raw.split(/\r?\n/);
    if (lines.length > 0 && lines.at(-1) === '') lines.pop();
    for (const line of lines) allLines.push(line);
  }
  if (read === 0) return null;

  const truncated = allLines.length > maxLines;
  const startLineNo = truncated ? allLines.length - maxLines : 0;
  const slice = truncated ? allLines.slice(startLineNo) : allLines;

  const lines: LogLine[] = slice.map((text, i) => parseLogLine(text, startLineNo + i + 1));
  return { lines, truncated };
}

export function parseLogLine(raw: string, lineNo: number): LogLine {
  const m = LINE_RE.exec(raw);
  if (m === null) {
    return { lineNo, time: null, level: null, message: raw, fields: {}, raw };
  }
  const time = m[1]!;
  const level = m[2]!.toUpperCase();
  const rest = m[3]!;

  const fields: Record<string, string> = {};
  let message = rest;
  const fieldStart = rest.search(FIELD_START_RE);
  if (fieldStart >= 0) {
    message = rest.slice(0, fieldStart).trim();
    const fieldsPart = rest.slice(fieldStart);
    for (const fm of fieldsPart.matchAll(FIELD_RE)) {
      fields[fm[1]!] = fm[2]!;
    }
  }
  return { lineNo, time, level, message: message.trim(), fields, raw };
}
