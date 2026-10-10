/**
 * Rule matching and layered verdict resolution. Forbidden is terminal and can
 * never be softened by a lower-precedence layer (a forbidden match anywhere
 * wins); then prompt beats allow. Provenance reports the highest-precedence
 * matching rule so approval UI can cite the controlling layer.
 */

import type {
  CommandDecision,
  ExecRule,
  NetworkRule,
  PrefixRule,
  SegmentDecision,
  SegmentVerdict,
} from './types';
import { compareSources } from './types';

export function matchesPrefixRule(rule: PrefixRule, argv: readonly string[]): boolean {
  if (argv.length < rule.pattern.length) {
    return false;
  }
  return rule.pattern.every((token, i) => token === argv[i]);
}

export function matchesHostPattern(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const bare = pattern.slice(2);
    return host === bare || host.endsWith(`.${bare}`);
  }
  return host === pattern;
}

export function matchesNetworkRule(
  rule: NetworkRule,
  host: string,
  protocol?: string,
): boolean {
  if (rule.protocol !== undefined && rule.protocol !== protocol) {
    return false;
  }
  return matchesHostPattern(rule.host, host);
}

function pickProvenance(matches: readonly ExecRule[]): ExecRule | undefined {
  return matches.reduce<ExecRule | undefined>(
    (best, r) => (best === undefined || compareSources(r.source, best.source) < 0 ? r : best),
    undefined,
  );
}

function resolveVerdict(matches: readonly ExecRule[]): SegmentDecision {
  for (const decision of ['forbidden', 'prompt', 'allow'] as const) {
    const group = matches.filter((r) => r.decision === decision);
    if (group.length > 0) {
      return { decision, matchedRule: pickProvenance(group) };
    }
  }
  return { decision: 'none' };
}

export function evaluateArgv(rules: readonly ExecRule[], argv: readonly string[]): SegmentDecision {
  const matches = rules.filter(
    (r): r is PrefixRule => r.kind === 'prefix_rule' && matchesPrefixRule(r, argv),
  );
  return resolveVerdict(matches);
}

export function evaluateHost(
  rules: readonly ExecRule[],
  host: string,
  protocol?: string,
): SegmentDecision {
  const matches = rules.filter(
    (r): r is NetworkRule => r.kind === 'network_rule' && matchesNetworkRule(r, host, protocol),
  );
  return resolveVerdict(matches);
}

const VERDICT_RANK: Record<SegmentVerdict, number> = {
  forbidden: 0,
  prompt: 1,
  allow: 2,
  none: 3,
};

/**
 * Most restrictive decision across segments. A `null` segment means the
 * splitter could not literalize it (expansion, subshell without static args)
 * and renders the whole command unanalyzable.
 */
export function evaluateSegments(
  rules: readonly ExecRule[],
  segments: readonly (readonly string[] | null)[],
): CommandDecision {
  const decisions: SegmentDecision[] = [];
  for (const segment of segments) {
    decisions.push(segment === null ? { decision: 'none' } : evaluateArgv(rules, segment));
  }
  if (segments.includes(null)) {
    return { verdict: 'unanalyzable', segments: decisions };
  }
  const worst = decisions.reduce<SegmentVerdict>(
    (acc, d) => (VERDICT_RANK[d.decision] < VERDICT_RANK[acc] ? d.decision : acc),
    'none',
  );
  return { verdict: worst, segments: decisions };
}
