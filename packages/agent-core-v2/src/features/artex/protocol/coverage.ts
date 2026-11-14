export type ArtexCoverageOutcome =
  | 'reported'
  | 'no_issue_found'
  | 'ruled_out'
  | 'not_applicable'
  | 'needs_follow_up';

export const ARTEX_COVERAGE_OUTCOMES: readonly ArtexCoverageOutcome[] = [
  'reported',
  'no_issue_found',
  'ruled_out',
  'not_applicable',
  'needs_follow_up',
];

export type ArtexCoverageGapKind =
  | 'needs_follow_up'
  | 'unrecorded_risk_class'
  | 'missing_evidence'
  | 'missing_reason';

export type ArtexCoverageCompletenessState =
  | 'complete'
  | 'in_progress'
  | 'paused'
  | 'timeout'
  | 'budget'
  | 'aborted';

export interface ArtexCoverageEntry {
  readonly surface: string;
  readonly riskArea: string;
  readonly outcome: ArtexCoverageOutcome;
  readonly evidence: string;
  readonly reason: string;
  readonly worker?: string;
  readonly intentId?: number;
  readonly updatedAt?: string;
}

export interface ArtexCoverageGap {
  readonly kind: ArtexCoverageGapKind;
  readonly surface?: string;
  readonly riskArea: string;
}

export interface ArtexCoverageCompleteness {
  readonly complete: boolean;
  readonly state: ArtexCoverageCompletenessState;
  readonly caveat: string;
}

export interface ArtexCoverageLedger {
  readonly entries: readonly ArtexCoverageEntry[];
  readonly gaps: readonly ArtexCoverageGap[];
  readonly unexamined: readonly string[];
  readonly findingsByClass: Readonly<Record<string, number>>;
  readonly completeness: ArtexCoverageCompleteness;
}

export function isValidArtexCoverageOutcome(value: string): value is ArtexCoverageOutcome {
  return (ARTEX_COVERAGE_OUTCOMES as readonly string[]).includes(value);
}
