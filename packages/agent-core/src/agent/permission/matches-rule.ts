import picomatch from 'picomatch';

import type { RunnableToolExecution } from '../../loop/types';
import { matchesRuleSubject } from '../../tools/support/rule-match';
import type { PermissionRule } from './types';

/**
 * DSL parser for PermissionRule `pattern` strings.
 *
 * Grammar:
 *   pattern    := toolName ( "(" argPattern ")" )?
 *   toolName   := identifier characters (e.g. `Bash`, `mcp__github__*`)
 *   argPattern := any string (may start with `!` for negation)
 *
 * Examples:
 *   "Write"            -> { toolName: "Write" }
 *   "Read(/etc/**)"    -> { toolName: "Read", argPattern: "/etc/**" }
 *   "Bash(!rm *)"      -> { toolName: "Bash", argPattern: "!rm *" }
 *   "mcp__github__*"   -> { toolName: "mcp__github__*" }
 */
export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string;
}

export interface PermissionRuleMatchExecution {
  readonly matchesRule?: RunnableToolExecution['matchesRule'];
  readonly cwd?: unknown;
  readonly pathClass?: unknown;
}

export type PermissionRuleMatchStrategy =
  | 'tool_name_only'
  | 'matches_rule'
  | 'stable_args_fallback'
  | 'single_field_fallback';

export interface PermissionRuleMatch {
  readonly rule: PermissionRule;
  readonly strategy: PermissionRuleMatchStrategy;
  readonly hasRuleArgs: boolean;
}

export interface PermissionRuleMatchInput {
  readonly rule: PermissionRule;
  readonly toolName: string;
  readonly args: unknown;
  readonly execution: PermissionRuleMatchExecution;
}

/**
 * Parse a DSL pattern. Throws on malformed input (missing closing paren,
 * empty tool name). The parser is the single source of truth for DSL syntax.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('permission pattern: empty string');
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  }
  return { toolName, argPattern };
}

export function matchPermissionRule({
  rule,
  toolName,
  args,
  execution,
}: PermissionRuleMatchInput): PermissionRuleMatch | undefined {
  let parsed;
  try {
    parsed = parsePattern(rule.pattern);
  } catch {
    return undefined;
  }

  if (parsed.toolName !== '*' && !picomatch.isMatch(toolName, parsed.toolName)) {
    return undefined;
  }

  if (parsed.argPattern === undefined) {
    return { rule, strategy: 'tool_name_only', hasRuleArgs: false };
  }

  if (execution.matchesRule !== undefined) {
    return execution.matchesRule(parsed.argPattern)
      ? { rule, strategy: 'matches_rule', hasRuleArgs: true }
      : undefined;
  }

  if (matchesRuleSubject(parsed.argPattern, stableSerialize(args))) {
    return { rule, strategy: 'stable_args_fallback', hasRuleArgs: true };
  }

  const singleField = singleActualFieldValue(args);
  if (
    singleField !== undefined &&
    matchesRuleSubject(parsed.argPattern, singleFieldSubject(singleField))
  ) {
    return { rule, strategy: 'single_field_fallback', hasRuleArgs: true };
  }

  return undefined;
}

function singleActualFieldValue(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  return entries.length === 1 ? entries[0]![1] : undefined;
}

function singleFieldSubject(value: unknown): string {
  return typeof value === 'string' ? value : stableSerialize(value);
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'symbol') return JSON.stringify(value.description ?? '');
  return JSON.stringify('[function]');
}
