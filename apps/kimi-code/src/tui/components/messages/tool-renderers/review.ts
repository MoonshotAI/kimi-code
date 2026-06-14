import type { ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';

import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

export interface ReviewToolLabel {
  readonly summary: string;
  readonly detail?: string;
}

const REVIEW_TOOL_NAMES = new Set([
  'GetAssignment',
  'GetChangedFiles',
  'ReadDiff',
  'ReadPatch',
  'ReadFileVersion',
  'UpdateProgress',
  'AddComment',
  'GetComments',
  'GetCommentEvidence',
  'MergeComments',
  'DismissComment',
]);
const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHORT_GIT_OBJECT_ID_LENGTH = 7;

export const reviewSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);
  return [];
};

export function isReviewToolName(toolName: string): boolean {
  return REVIEW_TOOL_NAMES.has(toolName);
}

export function formatReviewToolActivityLabel(
  toolName: string,
  args: Record<string, unknown>,
  display?: ToolInputDisplay | undefined,
): string | undefined {
  const formatted = formatReviewToolLabel(toolName, args, display);
  if (formatted === undefined) return undefined;
  if (formatted.detail === undefined) return formatted.summary;
  return `${formatted.summary} (${formatted.detail})`;
}

export function formatReviewToolLabel(
  toolName: string,
  args: Record<string, unknown>,
  display?: ToolInputDisplay | undefined,
): ReviewToolLabel | undefined {
  switch (toolName) {
    case 'GetAssignment':
      return label('Loaded review assignment');
    case 'GetChangedFiles':
      return label('Listed changed files', changedFilesDetail(args, display));
    case 'ReadDiff':
    case 'ReadPatch':
      return label(readDiffSummary(args), readDiffDetail(args, display));
    case 'ReadFileVersion':
      return label(
        readFileVersionSummary(args),
        readFileVersionDetail(args, display),
      );
    case 'UpdateProgress': {
      const status = stringArg(args, 'status');
      return label(progressUpdateSummary(status), progressUpdateDetail(args, display));
    }
    case 'AddComment':
      return label(
        'Added review comment',
        joinDetails([
          pathLineDetail(stringArg(args, 'path'), numberArg(args, 'line')),
          stringArg(args, 'severity'),
          stringArg(args, 'title'),
        ]) ?? displayDetail(display),
      );
    case 'GetComments':
      return label('Listed review comments', commentsDetail(args, display));
    case 'GetCommentEvidence':
      return label('Read comment evidence', stringArg(args, 'comment_id'));
    case 'MergeComments':
      return label(
        'Merged review comments',
        mergeDetail(args, display),
      );
    case 'DismissComment':
      return label(
        'Dismissed review comment',
        joinDetails([
          stringArg(args, 'comment_id'),
          stringArg(args, 'reason'),
          stringArg(args, 'summary'),
          prefixed('merged into', stringArg(args, 'merged_comment_id')),
        ]) ?? displayDetail(display),
      );
    default:
      return undefined;
  }
}

function label(summary: string, detail?: string): ReviewToolLabel {
  if (detail !== undefined && detail.length > 0) return { summary, detail };
  return { summary };
}

function changedFilesDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  const include = stringArg(args, 'include') === 'all' ? 'all files' : 'assigned files';
  const statuses = stringArrayArg(args, 'statuses');
  return joinDetails([
    include,
    statuses === undefined ? undefined : `statuses: ${statuses.join(', ')}`,
  ]) ?? displayDetail(display);
}

function readDiffDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  const paths = pathsArg(args);
  const sectionId = stringArg(args, 'section_id') ?? stringArg(args, 'hunk_id');
  const hasDiffArgs =
    paths !== undefined ||
    stringArg(args, 'path') !== undefined ||
    sectionId !== undefined ||
    numberArg(args, 'context_lines') !== undefined;
  if (!hasDiffArgs) return displayDetail(display) ?? 'assigned files';
  return joinDetails([
    pathsDetail(paths ?? legacyPathArg(args)),
    changedSectionDetail(sectionId),
    nearbyLinesDetail(numberArg(args, 'context_lines')),
  ]);
}

function readFileVersionDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  const hasFileArgs =
    stringArg(args, 'path') !== undefined ||
    stringArg(args, 'version') !== undefined ||
    stringArg(args, 'ref') !== undefined ||
    numberArg(args, 'line_offset') !== undefined ||
    numberArg(args, 'n_lines') !== undefined;
  if (!hasFileArgs) return displayDetail(display);
  const ref = stringArg(args, 'ref');
  const source = ref === undefined ? undefined : `ref ${formatReviewRefForLabel(ref)}`;
  return joinDetails([
    stringArg(args, 'path'),
    source,
    lineRangeLabel(numberArg(args, 'line_offset'), numberArg(args, 'n_lines')),
  ]);
}

function commentsDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  const scope = stringArg(args, 'scope') ?? 'all';
  const paths = stringArrayArg(args, 'paths');
  return joinDetails([
    stringArg(args, 'status'),
    scope === 'assigned' ? 'assigned scope' : 'all scope',
    paths === undefined ? undefined : paths.join(', '),
    boolArg(args, 'include_sources') === true ? 'include sources' : undefined,
  ]) ?? displayDetail(display);
}

function mergeDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  const sources = stringArrayArg(args, 'source_comment_ids');
  return joinDetails([
    pathLineDetail(stringArg(args, 'path'), numberArg(args, 'line')),
    sources === undefined ? undefined : countLabel(sources.length, 'source comment', 'source comments'),
    stringArg(args, 'severity'),
    stringArg(args, 'title'),
  ]) ?? displayDetail(display);
}

function readDiffSummary(args: Record<string, unknown>): string {
  return stringArg(args, 'section_id') === undefined && stringArg(args, 'hunk_id') === undefined
    ? 'Read changed lines'
    : 'Read changed section';
}

function readFileVersionSummary(args: Record<string, unknown>): string {
  const ref = stringArg(args, 'ref');
  if (ref !== undefined) return 'Read file at ref';
  switch (stringArg(args, 'version')) {
    case 'base':
      return 'Read base file state';
    case 'head':
      return 'Read HEAD file state';
    case 'current':
    case undefined:
      return 'Read current file state';
    default:
      return 'Read file state';
  }
}

function progressUpdateSummary(status: string | undefined): string {
  switch (status) {
    case 'complete':
      return 'Marked review complete';
    case 'blocked':
      return 'Marked review blocked';
    case 'active':
      return 'Updated review progress';
    case undefined:
      return 'Updated review progress';
    default:
      return `Updated review progress: ${status}`;
  }
}

function progressUpdateDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  if (stringArg(args, 'blocker') !== undefined) return 'blocker recorded';
  if (stringArg(args, 'summary') !== undefined) return 'summary recorded';
  return displayDetail(display);
}

function displayDetail(display: ToolInputDisplay | undefined): string | undefined {
  return display?.kind === 'generic' && typeof display.detail === 'string' && display.detail.length > 0
    ? display.detail
    : undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (strings.length === 0) return undefined;
  return strings;
}

function pathsArg(args: Record<string, unknown>): string[] | undefined {
  return stringArrayArg(args, 'paths');
}

function legacyPathArg(args: Record<string, unknown>): string[] | undefined {
  const path = stringArg(args, 'path');
  return path === undefined ? undefined : [path];
}

function pathsDetail(paths: readonly string[] | undefined): string | undefined {
  if (paths === undefined) return 'assigned files';
  if (paths.length === 1) return paths[0];
  return countLabel(paths.length, 'file', 'files');
}

function joinDetails(parts: readonly (string | undefined)[]): string | undefined {
  const compact = parts.filter((part): part is string => part !== undefined && part.length > 0);
  if (compact.length === 0) return undefined;
  return compact.join(' · ');
}

function prefixed(prefix: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${prefix}: ${value}`;
}

function pathLineDetail(path: string | undefined, line: number | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  if (line === undefined) return path;
  return `${path}:${String(line)}`;
}

function formatReviewRefForLabel(ref: string): string {
  return FULL_GIT_OBJECT_ID_RE.test(ref) ? ref.slice(0, SHORT_GIT_OBJECT_ID_LENGTH) : ref;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function changedSectionDetail(hunkId: string | undefined): string | undefined {
  if (hunkId === undefined) return undefined;
  const match = /^(?:hunk|section)-(\d+)$/i.exec(hunkId);
  return `section ${match?.[1] ?? hunkId}`;
}

function nearbyLinesDetail(count: number | undefined): string | undefined {
  if (count === undefined || count <= 0) return undefined;
  return countLabel(count, 'nearby line', 'nearby lines');
}

function lineRangeLabel(lineOffset: number | undefined, nLines: number | undefined): string {
  const start = lineOffset ?? 1;
  if (nLines === undefined) return `from line ${String(start)}`;
  if (nLines === 1) return `line ${String(start)}`;
  return `lines ${String(start)}-${String(start + nLines - 1)}`;
}
