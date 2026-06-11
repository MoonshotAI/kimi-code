import type { ToolInputDisplay } from '../../display';

const DETAIL_SEPARATOR = ' · ';
const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHORT_GIT_OBJECT_ID_LENGTH = 7;

export function reviewDisplay(summary: string, detail?: string): ToolInputDisplay {
  if (detail !== undefined && detail.length > 0) {
    return { kind: 'generic', summary, detail };
  }
  return { kind: 'generic', summary };
}

export function joinReviewDetails(parts: readonly (string | undefined)[]): string | undefined {
  const compact = parts.filter((part): part is string => part !== undefined && part.length > 0);
  if (compact.length === 0) return undefined;
  return compact.join(DETAIL_SEPARATOR);
}

export function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

export function lineRangeLabel(lineOffset: number | undefined, nLines: number | undefined): string {
  const start = lineOffset ?? 1;
  if (nLines === undefined) return `from line ${String(start)}`;
  if (nLines === 1) return `line ${String(start)}`;
  return `lines ${String(start)}-${String(start + nLines - 1)}`;
}

export function formatReviewRefForDisplay(ref: string): string {
  return FULL_GIT_OBJECT_ID_RE.test(ref) ? ref.slice(0, SHORT_GIT_OBJECT_ID_LENGTH) : ref;
}
