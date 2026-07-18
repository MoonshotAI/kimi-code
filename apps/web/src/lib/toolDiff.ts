// apps/kimi-web/src/lib/toolDiff.ts
// Builds the line diff shown inline inside an expanded Edit tool card.

import type { DiffViewLine } from '../types';
import { buildDiffLines } from './diffLines';
import { normalizeToolName } from './toolMeta';

function parseArg(arg: string): Record<string, unknown> | null {
  const s = arg.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Take a tool input's file path, regardless of which key the tool used. */
function filePath(d: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'filename']) {
    const value = d[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Character cap for content highlighted inline. Line/matrix caps alone let a
 * one-line minified bundle or base64 blob through — tokenizing such a line
 * costs per character, not per line, and can stall the UI for seconds.
 * Aligned with the Read tool's own 100KB output cap.
 */
const MAX_CONTENT_CHARS = 100 * 1024;

/**
 * Build a line diff for an Edit tool call from its input. Returns null for any
 * other tool, for operations a from-args diff cannot represent (replace_all),
 * or when the inputs are too large to diff cheaply.
 *
 * Write is deliberately excluded: it only reports the new content, and the
 * client cannot tell a new file from an overwrite of an existing one. A
 * from-empty diff would show an overwrite as "all additions, no deletions",
 * which is misleading — Write renders its content via buildWriteContent
 * instead.
 */
export function buildEditDiffLines(tool: { name: string; arg: string }): DiffViewLine[] | null {
  const kind = normalizeToolName(tool.name);
  if (kind !== 'edit' && kind !== 'write') return null;
  const d = parseArg(tool.arg);
  if (!d) return null;
  if (kind === 'edit') {
    if (d.replace_all === true) return null;
    const before = typeof d.old_string === 'string' ? d.old_string : undefined;
    const after = typeof d.new_string === 'string' ? d.new_string : undefined;
    if (before === undefined || after === undefined) return null;
    if (before.length > MAX_CONTENT_CHARS || after.length > MAX_CONTENT_CHARS) return null;
    return buildDiffLines(before, after);
  }
  return null;
}

/**
 * Cap on the number of content lines rendered inline for a Write. Highlighting
 * is async, but the content still becomes DOM rows, so pathologically large
 * writes fall back to the tool output instead.
 */
const MAX_CONTENT_LINES = 5000;

export interface WriteContent {
  content: string;
  path?: string;
}

/**
 * Extract the content shown inline for a Write tool call (rendered as a
 * syntax-highlighted code block — see buildEditDiffLines for why a diff
 * misleads). Returns null for non-Write tools, a missing/non-string content,
 * or content too large to render cheaply; callers fall back to the raw tool
 * output.
 */
export function buildWriteContent(tool: { name: string; arg: string }): WriteContent | null {
  if (normalizeToolName(tool.name) !== 'write') return null;
  const d = parseArg(tool.arg);
  if (!d || typeof d.content !== 'string') return null;
  if (d.content.length > MAX_CONTENT_CHARS) return null;
  if (d.content.split('\n').length > MAX_CONTENT_LINES) return null;
  return { content: d.content, path: filePath(d) };
}

/**
 * The file path carried by a tool input (Read/Edit/Write), regardless of
 * which key the tool used — feeds language inference for syntax highlighting.
 */
export function toolFilePath(tool: { arg: string }): string | undefined {
  const d = parseArg(tool.arg);
  return d ? filePath(d) : undefined;
}
