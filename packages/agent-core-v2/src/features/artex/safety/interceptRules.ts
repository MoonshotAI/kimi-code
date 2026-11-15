import type { ArtexInterceptAction, ArtexInterceptRule } from '#/features/artex/store/artexWorkStore';

import { argvRuleMatches, checkArgvAllow, parseArgvPattern, type ArtexBashParse } from './argv';

/**
 * The tools whose calls enter the intercept rule system. Ported from ARTEX
 * intercept.defaultEnabledTools, adapted to the kimi-code tool names.
 */
export const ARTEX_RULE_ENABLED_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'WebFetch',
  'web_search',
  'Write',
  'Edit',
  'MultiEdit',
]);

const ARTEX_BUILTIN_RULE_PREFIX = '[built-in]';

export interface ArtexInterceptDecision {
  readonly action: ArtexInterceptAction;
  readonly message: string;
  readonly ruleName: string;
  readonly ruleId: number;
}

export interface ArtexInterceptMatchOptions {
  readonly builtinDenyOnly?: boolean;
}

/**
 * Evaluates the enabled intercept rules (priority DESC) against one tool call and
 * returns the first match, or undefined. Ported from ARTEX intercept.Match /
 * MatchBuiltin. The rule list is expected pre-sorted by the store.
 */
export function matchInterceptRules(
  rules: readonly ArtexInterceptRule[],
  toolName: string,
  inputText: string,
  command: string | undefined,
  parse: ArtexBashParse,
  options?: ArtexInterceptMatchOptions,
): ArtexInterceptDecision | undefined {
  if (!ARTEX_RULE_ENABLED_TOOLS.has(toolName)) return undefined;
  const builtinDenyOnly = options?.builtinDenyOnly ?? false;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (builtinDenyOnly && (rule.action !== 'deny' || !rule.name.startsWith(ARTEX_BUILTIN_RULE_PREFIX))) {
      continue;
    }
    if (!ruleMatches(rule, toolName, inputText, command, parse)) continue;
    const message = rule.message !== '' ? rule.message : defaultInterceptMessage(rule.action, rule.name);
    return { action: rule.action, message, ruleName: rule.name, ruleId: rule.id };
  }
  return undefined;
}

function ruleMatches(
  rule: ArtexInterceptRule,
  toolName: string,
  inputText: string,
  command: string | undefined,
  parse: ArtexBashParse,
): boolean {
  if (rule.matchType === 'argv') {
    const tokens = parseArgvPattern(rule.pattern);
    if (tokens === undefined) return false;
    if (rule.action === 'allow' && checkArgvAllow(tokens)) return false;
    return rule.matchTarget === 'tool_input' && argvRuleMatches(tokens, toolName, command, parse);
  }
  const subject = rule.matchTarget === 'tool_name' ? toolName : inputText;
  if (rule.matchType === 'regex') {
    const regex = compileArtexRegex(rule.pattern);
    return regex !== undefined && regex.test(subject);
  }
  return subject.includes(rule.pattern);
}

export function defaultInterceptMessage(action: ArtexInterceptAction, name: string): string {
  switch (action) {
    case 'deny':
      return `intercept rule [${name}] forbids executing this tool`;
    case 'ask':
      return `intercept rule [${name}] requires user approval, please wait`;
    case 'allow':
      return '';
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * Compiles a Go-style regex pattern for JavaScript: a leading or inline `(?i)`
 * flag becomes the `i` flag (RE2 inline flags are not valid in JS RegExp). An
 * uncompilable pattern yields undefined so the rule is skipped, matching ARTEX
 * compileRule behavior.
 */
export function compileArtexRegex(pattern: string): RegExp | undefined {
  let source = pattern;
  let flags = '';
  if (source.includes('(?i)')) {
    flags = 'i';
    source = source.split('(?i)').join('');
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}
