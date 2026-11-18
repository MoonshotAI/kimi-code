
import type { DiffViewLine } from './types';
import { buildDiffLines, splitLines } from './diffLines';
import { normalizeToolName } from '../lib/normalizeToolName';

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

function filePath(d: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'filename']) {
    const value = d[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

const MAX_CONTENT_CHARS = 100 * 1024;

export function buildEditDiffLines(tool: { name: string; arg: string }): DiffViewLine[] | null {
  const kind = normalizeToolName(tool.name);
  if (kind !== 'edit' && kind !== 'multi_edit') return null;
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
  const edits = Array.isArray(d.edits) ? d.edits : undefined;
  if (!edits || edits.length === 0) return null;
  const out: DiffViewLine[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  for (const e of edits) {
    if (!e || typeof e !== 'object') return null;
    const edit = e as Record<string, unknown>;
    if (edit.replace_all === true) return null;
    const before = typeof edit.old_string === 'string' ? edit.old_string : undefined;
    const after = typeof edit.new_string === 'string' ? edit.new_string : undefined;
    if (before === undefined || after === undefined) return null;
    if (before.length > MAX_CONTENT_CHARS || after.length > MAX_CONTENT_CHARS) return null;
    const segment = buildDiffLines(before, after);
    if (segment === null) return null;
    if (out.length > 0) out.push({ type: 'hunk', text: '···' });
    for (const line of segment) {
      out.push({
        ...line,
        oldNo: line.oldNo !== undefined ? line.oldNo + oldOffset : undefined,
        newNo: line.newNo !== undefined ? line.newNo + newOffset : undefined,
      });
    }
    oldOffset += splitLines(before).length;
    newOffset += splitLines(after).length;
  }
  return out;
}

const MAX_CONTENT_LINES = 5000;

export interface WriteContent {
  content: string;
  path?: string;
}

export function buildWriteContent(tool: { name: string; arg: string }): WriteContent | null {
  if (normalizeToolName(tool.name) !== 'write') return null;
  const d = parseArg(tool.arg);
  if (!d || typeof d.content !== 'string') return null;
  if (d.content.length > MAX_CONTENT_CHARS) return null;
  if (d.content.split('\n').length > MAX_CONTENT_LINES) return null;
  return { content: d.content, path: filePath(d) };
}

export function toolFilePath(tool: { arg: string }): string | undefined {
  const d = parseArg(tool.arg);
  return d ? filePath(d) : undefined;
}
