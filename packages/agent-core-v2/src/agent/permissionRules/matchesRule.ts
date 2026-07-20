import picomatch from 'picomatch';

import type { RunnableToolExecution } from '#/tool/toolContract';
import type { PermissionRule } from './permissionRules';

export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string;
}

export type ParsedPermissionPattern = ParsedPattern;

export interface PermissionRuleMatchExecution {
  readonly matchesRule?: RunnableToolExecution['matchesRule'];
}

export type PermissionRuleMatchStrategy = 'tool_name_only' | 'matches_rule';

export interface PermissionRuleMatch {
  readonly rule: PermissionRule;
  readonly strategy: PermissionRuleMatchStrategy;
  readonly hasRuleArgs: boolean;
}

export interface PermissionRuleMatchInput {
  readonly rule: PermissionRule;
  readonly toolName: string;
  readonly execution: PermissionRuleMatchExecution;
}

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
  if (argPattern.length === 0) {
    return { toolName };
  }
  return { toolName, argPattern };
}

export const parsePermissionPattern = parsePattern;

export function matchPermissionRule({
  rule,
  toolName,
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

  return execution.matchesRule?.(parsed.argPattern) === true
    ? { rule, strategy: 'matches_rule', hasRuleArgs: true }
    : undefined;
}
