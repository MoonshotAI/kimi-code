// apps/kimi-web/src/lib/toolDiff.ts
// Helpers for previewing Edit/Write tool calls: build the line diff and locate
// a live tool call in the session turns so the side panel can stay reactive.

import type { ChatTurn, DiffViewLine, ToolCall } from '../types';
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

/**
 * Build a line diff for an Edit/Write tool call from its input. Returns null
 * for any other tool, for operations a from-args diff cannot represent
 * (replace_all, append), or when the inputs are too large to diff cheaply.
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
    return buildDiffLines(before, after);
  }
  // Write only reports the new content (and whether it appended); the client
  // cannot tell a new file from an overwrite of an existing one. A from-empty
  // diff would show an overwrite as "all additions, no deletions", which is
  // misleading — so fall back to the tool output for every Write.
  return null;
}

/** Pull the file path out of an Edit/Write tool call's input, if present. */
export function extractEditPath(arg: string): string | undefined {
  const d = parseArg(arg);
  return d && typeof d.path === 'string' ? d.path : undefined;
}

/** Find a tool call by id across all session turns (for the live panel lookup). */
export function findToolCallById(turns: ChatTurn[], id: string): ToolCall | undefined {
  for (const turn of turns) {
    const found = turn.tools?.find((t) => t.id === id);
    if (found) return found;
  }
  return undefined;
}
