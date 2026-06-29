// apps/vis/server/src/lib/log-reader.ts
//
// Parse a kimi-code diagnostic log into structured lines for the Logs view.
//
// Lines look like:
//   2026-06-15T05:32:08.722Z INFO  llm config  turnStep=0.1 provider=openai …
// i.e. `<ISO time> <LEVEL> <message>  <key=value …>`. Anything that does not
// match (continuation lines, stack traces) is kept verbatim as a level-less,
// time-less message so nothing is dropped.

import { readFile, stat } from 'node:fs/promises';

import type { LogLine } from './agent-record-types';

/** Cap served lines so a multi-hundred-MB log cannot blow up the response.
 *  When exceeded we keep the TAIL (most recent), where failures usually are. */
const MAX_LINES = 20_000;

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([A-Za-z]+)\s+(.*)$/;
const FIELD_START_RE = /(^|\s)[A-Za-z_][\w.-]*=/;
const FIELD_RE = /([A-Za-z_][\w.-]*)=(\S+)/g;

export interface LogReadResult {
  lines: LogLine[];
  truncated: boolean;
}

export async function logExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Read and parse a log file. Returns null when the file is absent. */
export async function readLog(path: string, maxLines = MAX_LINES): Promise<LogReadResult | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const allLines = raw.split(/\r?\n/);
  // Drop a single trailing empty line from the final newline.
  if (allLines.length > 0 && allLines.at(-1) === '') allLines.pop();

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
