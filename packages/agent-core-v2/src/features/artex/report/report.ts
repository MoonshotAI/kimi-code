import { coverageGapLabel } from '#/features/artex/logic/coverageLedger';
import type {
  ArtexAsset,
  ArtexFindingNode,
  ArtexTaskScope,
} from '#/features/artex/protocol/index';

import type { ArtexReportInput } from './types';

export const REPORT_MAX_GAPS = 200;
const REPORT_MAX_TIMELINE = 200;

export const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  '': 4,
};

export function severityOrder(severity: string): number {
  return SEVERITY_RANK[severity] ?? 4;
}

export function nonEmptyOr(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === '') return fallback;
  return value;
}

export function formatReportTimestamp(value?: Date | string): string {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '1970-01-01 00:00:00';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

interface ParsedFindingView {
  readonly vulnclass: string;
  readonly name: string;
  readonly severity: string;
  readonly summary: string;
  readonly poc: string;
  readonly verificationStatus: string;
}

function parseFindingNode(node: ArtexFindingNode): ParsedFindingView {
  const payload = node.payload;
  const rawEvidence = payload['evidence'];
  let poc = '';
  if (typeof rawEvidence === 'string') {
    poc = rawEvidence;
  } else if (typeof rawEvidence === 'object' && rawEvidence !== null) {
    const maybePoc = (rawEvidence as Record<string, unknown>)['poc'];
    if (typeof maybePoc === 'string') poc = maybePoc;
  }
  return {
    vulnclass: typeof payload['vulnclass'] === 'string' ? payload['vulnclass'] : '',
    name: typeof payload['name'] === 'string' ? payload['name'] : '',
    severity: typeof payload['severity'] === 'string' ? payload['severity'] : '',
    summary: typeof payload['summary'] === 'string' ? payload['summary'] : '',
    poc,
    verificationStatus:
      typeof payload['verification_status'] === 'string' ? payload['verification_status'] : '',
  };
}

function resolveAssetCounts(
  explicit: Readonly<Record<string, number>> | undefined,
  assets: readonly ArtexAsset[] | undefined,
): Record<string, number> {
  if (explicit !== undefined) return { ...explicit };
  const counts: Record<string, number> = {};
  if (assets === undefined) return counts;
  for (const asset of assets) {
    counts[asset.type] = (counts[asset.type] ?? 0) + 1;
  }
  return counts;
}

function formatScopeLine(scope: ArtexTaskScope): string {
  const target = scope.domain ?? scope.net ?? scope.value ?? (scope.companyId !== undefined ? `company:${String(scope.companyId)}` : '');
  const reason = scope.reason !== undefined && scope.reason.trim() !== '' ? ` — ${scope.reason.trim()}` : '';
  return `- \`${scope.kind}\`: ${nonEmptyOr(target, '(unspecified)')} (${scope.source})${reason}`;
}

export function renderMarkdownReport(input: ArtexReportInput): string {
  const lines: string[] = [
    `# Penetration Test Report — ${nonEmptyOr(input.title, 'Unnamed task')}`,
    '',
    `- **Task goal**: ${nonEmptyOr(input.goal, '(unspecified)')}`,
    `- **Generated at**: ${formatReportTimestamp(input.generatedAt)}`,
  ];
  if (input.exploration !== undefined) {
    lines.push(
      `- **Exploration status**: ${input.exploration.status} (round ${String(input.exploration.roundNo)})`,
    );
    if (input.exploration.goalMetReason !== undefined && input.exploration.goalMetReason.trim() !== '') {
      lines.push(`- **Completion note**: ${input.exploration.goalMetReason.trim()}`);
    }
  }
  lines.push('');

  const parsedFindings = input.findings.map(parseFindingNode);
  const severityCounts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of parsedFindings) {
    const key = f.severity in severityCounts ? f.severity : 'info';
    severityCounts[key] = (severityCounts[key] ?? 0) + 1;
  }

  const assetCounts = resolveAssetCounts(input.assetCounts, input.assets);
  const assetTypes = Object.keys(assetCounts).toSorted((a, b) => a.localeCompare(b));
  const assetSummary =
    assetTypes.length === 0
      ? 'none'
      : assetTypes.map((type) => `${type} ${String(assetCounts[type] ?? 0)}`).join(', ');

  lines.push('## Summary', '');
  lines.push(`- Confirmed findings: **${String(input.findings.length)}**`);
  if (parsedFindings.length > 0) {
    lines.push(
      `- Severity breakdown: Critical ${String(severityCounts['critical'] ?? 0)}, High ${String(severityCounts['high'] ?? 0)}, Medium ${String(severityCounts['medium'] ?? 0)}, Low ${String(severityCounts['low'] ?? 0)}, Info ${String(severityCounts['info'] ?? 0)}`,
    );
  }
  lines.push(`- Assets: ${assetSummary}`);
  if (input.scopes !== undefined) {
    lines.push(`- Scope entries: ${String(input.scopes.length)}`);
  }
  lines.push('');

  lines.push('## Findings', '');
  if (parsedFindings.length === 0) {
    lines.push('_No vulnerabilities confirmed this time._', '');
  } else {
    const indexed = parsedFindings.map((item, idx) => ({ item, idx }));
    indexed.sort(
      (a, b) =>
        severityOrder(a.item.severity) - severityOrder(b.item.severity) || a.idx - b.idx,
    );
    for (let i = 0; i < indexed.length; i += 1) {
      const f = indexed[i]!.item;
      const sevLabel = nonEmptyOr(f.severity, 'info').toUpperCase();
      const title = nonEmptyOr(f.name, nonEmptyOr(f.vulnclass, 'Uncategorized'));
      lines.push(`### ${String(i + 1)}. [${sevLabel}] ${title}`, '');
      if (f.vulnclass !== '' || f.verificationStatus !== '') {
        const meta: string[] = [];
        if (f.vulnclass !== '') meta.push(`Class: ${f.vulnclass}`);
        if (f.verificationStatus !== '') meta.push(`Verification: ${f.verificationStatus}`);
        lines.push(`- ${meta.join(' · ')}`, '');
      }
      if (f.summary.trim() !== '') {
        lines.push(f.summary, '');
      }
      if (f.poc.trim() !== '') {
        lines.push('**PoC / Evidence:**', '', '```', f.poc, '```', '');
      }
    }
  }

  if (input.scopes !== undefined && input.scopes.length > 0) {
    lines.push('## Scope', '');
    for (const scope of input.scopes) {
      lines.push(formatScopeLine(scope));
    }
    lines.push('');
  }

  if (input.coverage !== undefined) {
    const cov = input.coverage;
    lines.push('## Coverage gaps', '');
    lines.push(`- **Completeness**: ${cov.completeness.state}. ${cov.completeness.caveat}`);
    lines.push(
      `- Ledger entries: ${String(cov.entries.length)}, open gaps: ${String(cov.gaps.length)}`,
    );
    const limit = Math.min(cov.gaps.length, REPORT_MAX_GAPS);
    for (let i = 0; i < limit; i += 1) {
      lines.push(`- ${coverageGapLabel(cov.gaps[i]!)}`);
    }
    if (cov.gaps.length > REPORT_MAX_GAPS) {
      lines.push(
        `- and ${String(cov.gaps.length - REPORT_MAX_GAPS)} more (see the coverage API)`,
      );
    }
    lines.push('');
  }

  const hasMethodology =
    input.methodology !== undefined &&
    (typeof input.methodology === 'string'
      ? input.methodology.trim() !== ''
      : input.methodology.length > 0);
  const hasTimeline = input.timeline !== undefined && input.timeline.length > 0;

  if (hasMethodology || hasTimeline) {
    lines.push('## Methodology & Timeline', '');
    if (hasMethodology) {
      if (typeof input.methodology === 'string') {
        lines.push(input.methodology.trim(), '');
      } else if (input.methodology !== undefined) {
        for (const step of input.methodology) {
          if (step.trim() !== '') lines.push(`- ${step.trim()}`);
        }
        lines.push('');
      }
    }
    if (hasTimeline && input.timeline !== undefined) {
      const entries = input.timeline.slice(0, REPORT_MAX_TIMELINE);
      for (const entry of entries) {
        const detail = nonEmptyOr(entry.summary, nonEmptyOr(entry.text, entry.kind));
        const toolTag = entry.tool !== undefined && entry.tool !== '' ? ` [${entry.tool}]` : '';
        lines.push(`- ${formatReportTimestamp(entry.at)} · \`${entry.actor}\`${toolTag}: ${detail}`);
      }
      if (input.timeline.length > REPORT_MAX_TIMELINE) {
        lines.push(
          `- and ${String(input.timeline.length - REPORT_MAX_TIMELINE)} more timeline entries`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
