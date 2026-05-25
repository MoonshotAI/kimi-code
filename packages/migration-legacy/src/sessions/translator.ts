import { normalizeContentPart, type NormalizedContentPart } from './content-part.js';

export interface NormalizedMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: readonly NormalizedContentPart[];
  readonly toolCalls: ReadonlyArray<{
    readonly type: 'function';
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly toolCallId?: string;
}

const DROPPED_ROLES = new Set(['_system_prompt', '_checkpoint', '_usage']);

// The roles `translateContextLines` keeps — the inverse of the markers it
// drops. A context with none of these has no migratable conversation.
const USABLE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool']);

/**
 * The three meaningful outcomes for a session's `context.jsonl`.
 *
 *  - `'real'`    — has at least one `user` / `assistant` / `tool` row →
 *                  migratable conversation.
 *  - `'empty'`   — parses, but only carries markers (`_system_prompt`,
 *                  `_checkpoint`, `_usage`) or is genuinely blank → an unused
 *                  session, or one the user cleared in kimi-cli.
 *  - `'corrupt'` — every non-blank line failed to parse → disk damage,
 *                  truncated write, etc. Must NOT be conflated with `empty`
 *                  or its data problem disappears into the skip count.
 */
export type ContextContent = 'real' | 'empty' | 'corrupt';

/**
 * Classify a `context.jsonl`'s payload by scanning its lines. Distinguishes a
 * cleared/empty session from a corrupt one — the latter is a data problem
 * users need visibility into. Early-exits on the first usable row.
 */
export function analyzeContextContent(lines: readonly string[]): ContextContent {
  let hadParseableLine = false;
  let hadAnyNonBlank = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    hadAnyNonBlank = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    hadParseableLine = true;
    const role = (parsed as Record<string, unknown>)['role'];
    if (typeof role === 'string' && USABLE_ROLES.has(role)) return 'real';
  }
  if (hadAnyNonBlank && !hadParseableLine) return 'corrupt';
  return 'empty';
}

/**
 * Convenience wrapper: `true` iff the context has at least one translatable
 * message. Equivalent to `analyzeContextContent(...) === 'real'`.
 */
export function containsUsableMessage(lines: readonly string[]): boolean {
  return analyzeContextContent(lines) === 'real';
}

export function translateContextLines(lines: readonly string[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const obj = parsed as Record<string, unknown>;
    const role = obj['role'];
    if (typeof role !== 'string') continue;
    if (DROPPED_ROLES.has(role)) continue;

    if (role === 'user') {
      out.push(buildUser(obj));
    } else if (role === 'assistant') {
      out.push(buildAssistant(obj));
    } else if (role === 'tool') {
      out.push(buildTool(obj));
    }
    // else: unknown role, skip
  }
  return out;
}

function normalizeContent(raw: unknown): NormalizedContentPart[] {
  // A legacy row may legitimately omit `content` (e.g. an assistant message
  // that only carries tool calls). kimi's message shape allows `content: []`;
  // stringifying nullish here would emit a phantom text part holding `""`.
  if (raw === null || raw === undefined) {
    return [];
  }
  if (typeof raw === 'string') {
    return [{ type: 'text', text: raw }];
  }
  if (Array.isArray(raw)) {
    return raw.map(normalizeContentPart);
  }
  // Fallback: stringify any other scalar/object shape into a text part.
  return [{ type: 'text', text: JSON.stringify(raw) }];
}

function buildUser(obj: Record<string, unknown>): NormalizedMessage {
  return {
    role: 'user',
    content: normalizeContent(obj['content']),
    toolCalls: [],
  };
}

function buildAssistant(obj: Record<string, unknown>): NormalizedMessage {
  const toolCalls = Array.isArray(obj['tool_calls'])
    ? (obj['tool_calls'] as unknown[]).map(parseToolCall).filter(isNonNull)
    : [];
  return {
    role: 'assistant',
    content: normalizeContent(obj['content']),
    toolCalls,
  };
}

function buildTool(obj: Record<string, unknown>): NormalizedMessage {
  const toolCallId = typeof obj['tool_call_id'] === 'string' ? obj['tool_call_id'] : '';
  return {
    role: 'tool',
    content: normalizeContent(obj['content']),
    toolCalls: [],
    toolCallId,
  };
}

interface RawToolCall {
  readonly type: 'function';
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

function parseToolCall(raw: unknown): RawToolCall | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'function') return undefined;
  if (typeof r['id'] !== 'string') return undefined;
  const fn = r['function'];
  if (typeof fn !== 'object' || fn === null) return undefined;
  const f = fn as Record<string, unknown>;
  if (typeof f['name'] !== 'string') return undefined;
  const args = typeof f['arguments'] === 'string' ? f['arguments'] : '';
  return {
    type: 'function',
    id: r['id'],
    function: { name: f['name'], arguments: args },
  };
}

function isNonNull<T>(x: T | undefined): x is T {
  return x !== undefined;
}
