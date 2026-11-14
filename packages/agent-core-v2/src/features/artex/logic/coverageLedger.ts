import type {
  ArtexCoverageCompleteness,
  ArtexCoverageCompletenessState,
  ArtexCoverageEntry,
  ArtexCoverageGap,
  ArtexCoverageLedger,
} from '#/features/artex/protocol/index';

export function normalizeCoverageField(value: string): string {
  const withoutControls = value.replaceAll(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  return withoutControls
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ');
}

export function normalizeRiskArea(value: string): string {
  return normalizeCoverageField(value).toLowerCase();
}

export function coverageGapLabel(gap: ArtexCoverageGap): string {
  if (gap.surface === undefined || gap.surface === '') return `${gap.kind} ${gap.riskArea}`;
  return `${gap.kind} ${gap.surface} ${gap.riskArea}`;
}

export function buildCoverageLedger(
  entries: readonly ArtexCoverageEntry[],
  mandatory: readonly string[],
  completeness: ArtexCoverageCompleteness,
): ArtexCoverageLedger {
  const gaps: ArtexCoverageGap[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(normalizeRiskArea(entry.riskArea));
    if (entry.outcome === 'needs_follow_up') {
      gaps.push({ kind: 'needs_follow_up', surface: entry.surface, riskArea: entry.riskArea });
    } else if (entry.outcome === 'no_issue_found' && entry.evidence.trim() === '') {
      gaps.push({ kind: 'missing_evidence', surface: entry.surface, riskArea: entry.riskArea });
    } else if (
      (entry.outcome === 'ruled_out' || entry.outcome === 'not_applicable') &&
      entry.reason.trim() === ''
    ) {
      gaps.push({ kind: 'missing_reason', surface: entry.surface, riskArea: entry.riskArea });
    }
  }
  const unexamined: string[] = [];
  const added = new Set<string>();
  for (const raw of mandatory) {
    const normalized = normalizeRiskArea(raw);
    if (normalized !== '' && !seen.has(normalized) && !added.has(normalized)) {
      added.add(normalized);
      unexamined.push(normalized);
    }
  }
  unexamined.sort();
  const unrecorded: ArtexCoverageGap[] = unexamined.map((riskArea) => ({
    kind: 'unrecorded_risk_class',
    riskArea,
  }));
  return {
    entries,
    gaps: [...unrecorded, ...gaps],
    unexamined,
    findingsByClass: {},
    completeness,
  };
}

export function coverageCompletenessFor(
  status: string,
  paused: boolean,
  budget: boolean,
  pastDeadline: boolean,
): ArtexCoverageCompleteness {
  let state: ArtexCoverageCompletenessState = 'complete';
  if (budget) {
    state = 'budget';
  } else if (status === 'timeout' || (status === 'done' && pastDeadline)) {
    state = 'timeout';
  } else if (status === 'failed') {
    state = 'aborted';
  } else if (paused || status === 'paused') {
    state = 'paused';
  } else if (status !== 'done') {
    state = 'in_progress';
  }
  if (state === 'complete') {
    return {
      complete: true,
      state,
      caveat: 'Run ended normally. Classes listed as unexamined were not tested and are not clean.',
    };
  }
  return {
    complete: false,
    state,
    caveat: `Incomplete scan (${state}): the absence of a finding does not mean the target is clean; unexamined classes and open gaps were not covered.`,
  };
}
