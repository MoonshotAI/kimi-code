/**
 * exec-policy rule model — the shared vocabulary for layered command rules.
 * Codex-style decisions (allow/prompt/forbidden) over argv-prefix and host
 * matchers, tagged with the layer the rule came from for provenance.
 */

export type RuleDecision = 'allow' | 'prompt' | 'forbidden';

export type RuleSource =
  | 'managed'
  | 'user'
  | 'project'
  | 'session-runtime'
  | 'builtin';

export interface RuleBase {
  readonly decision: RuleDecision;
  readonly justification?: string;
  readonly source: RuleSource;
}

export interface PrefixRule extends RuleBase {
  readonly kind: 'prefix_rule';
  /** argv token-prefix; every pattern token must equal argv[i] exactly. */
  readonly pattern: readonly string[];
}

export interface NetworkRule extends RuleBase {
  readonly kind: 'network_rule';
  /** Exact host or `*.example.com` suffix wildcard. */
  readonly host: string;
  /** Optional protocol filter such as 'http', 'https', 'socks5'. */
  readonly protocol?: string;
}

export type ExecRule = PrefixRule | NetworkRule;

/** Rule literal as authored — `source` is stamped by the loader. */
export type UnsourcedRule =
  | Omit<PrefixRule, 'source'>
  | Omit<NetworkRule, 'source'>;

export type SegmentVerdict = RuleDecision | 'none';

export interface SegmentDecision {
  readonly decision: SegmentVerdict;
  /** Highest-precedence matching rule of the winning decision, if any. */
  readonly matchedRule?: ExecRule;
}

export type CommandVerdict = RuleDecision | 'unanalyzable' | 'none';

export interface CommandDecision {
  readonly verdict: CommandVerdict;
  readonly segments: readonly SegmentDecision[];
}

const SOURCE_RANK: Record<RuleSource, number> = {
  managed: 0,
  user: 1,
  'session-runtime': 2,
  project: 3,
  builtin: 4,
};

export function compareSources(a: RuleSource, b: RuleSource): number {
  return SOURCE_RANK[a] - SOURCE_RANK[b];
}
