/**
 * `tools` domain — Bash command decomposition for permission-rule matching.
 *
 * Splits a parsed bash command into the executable unit texts — commands and
 * test commands (with their redirections and assignment prefixes attached),
 * standalone variable assignments, redirected groups, and the payloads of
 * command / process substitutions at any depth — so rule evaluation can judge
 * a compound command per unit instead of as one opaque string. A `deny`/`ask`
 * rule matches when the whole command or any unit matches. An `allow` rule
 * auto-matches only when the command parses cleanly and every unit matches,
 * or the pattern is the escaped literal of the whole command (the
 * session-approval shape, which re-approves a previously approved compound
 * command without letting a wildcard span operators) — parse failure or
 * budget exhaustion must not fall back to whole-string globbing, since both
 * are exactly the over-match being closed. An unknown (undefined) decision
 * never expands into per-part matching, since that expansion is only sound
 * once the allow/deny direction is known. Quoted operators and heredoc
 * bodies are data, not units — extraction trusts the grammar, which only
 * surfaces substitution nodes where bash would execute them. The tree walk
 * is iterative because in-budget trees can still be thousands of levels deep.
 * Collaborators: parses through `bashParser`, matches through `rule-match`.
 * Pure functions plus a memoizing provider; no scoped service.
 */

import type { BashSyntaxNode, IBashParserService } from '#/app/bashParser/bashParser';
import { escapeRuleSubjectLiteral, matchesGlobRuleSubject } from '#/tool/rule-match';
import type { RuleMatchDecision } from '#/tool/toolContract';

const BASH_RULE_PARSE_OPTIONS = { timeoutMs: 20, maxNodes: 10_000 } as const;

const COMMAND_LIKE_TYPES: ReadonlySet<string> = new Set([
  'command',
  'test_command',
  'declaration_command',
  'unset_command',
]);

const SUBSTITUTION_TYPES: ReadonlySet<string> = new Set([
  'command_substitution',
  'process_substitution',
]);

export function matchesDecomposedCommandRule(
  ruleArgs: string,
  command: string,
  decision: RuleMatchDecision | undefined,
  parts: () => readonly string[] | null,
): boolean {
  if (decision === 'allow') {
    const resolved = parts();
    if (
      resolved !== null &&
      resolved.length > 0 &&
      resolved.every((part) => matchesGlobRuleSubject(ruleArgs, part))
    ) {
      return true;
    }
    return ruleArgs === escapeRuleSubjectLiteral(command);
  }
  if (matchesGlobRuleSubject(ruleArgs, command)) return true;
  if (decision === undefined) return false;
  const resolved = parts();
  return resolved !== null && resolved.some((part) => matchesGlobRuleSubject(ruleArgs, part));
}

export function createCommandPartsProvider(
  parser: IBashParserService,
  command: string,
): () => readonly string[] | null {
  let cached: readonly string[] | null | undefined;
  return () => {
    if (cached === undefined) cached = computeCommandParts(parser, command);
    return cached;
  };
}

function computeCommandParts(parser: IBashParserService, command: string): readonly string[] | null {
  const parsed = parser.parse(command, BASH_RULE_PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) return null;
  return extractCommandParts(parsed.root);
}

export function extractCommandParts(root: BashSyntaxNode): string[] {
  const parts: string[] = [];
  const stack: Array<readonly [BashSyntaxNode, boolean]> = [[root, false]];
  while (stack.length > 0) {
    const [node, covered] = stack.pop()!;
    let childrenCovered = covered;
    if (SUBSTITUTION_TYPES.has(node.type)) {
      childrenCovered = false;
    } else if (COMMAND_LIKE_TYPES.has(node.type) || node.type === 'variable_assignment') {
      if (!covered) parts.push(node.text);
      childrenCovered = true;
    } else if (node.type === 'redirected_statement') {
      if (!covered) parts.push(node.text);
      childrenCovered = node.children.some(
        (child) => child.isNamed && COMMAND_LIKE_TYPES.has(child.type),
      );
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]!;
      if (child.isNamed) stack.push([child, childrenCovered]);
    }
  }
  return parts;
}
