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
      return label('review assignment');
    case 'GetChangedFiles':
      return label('changed files', changedFilesDetail(args, display));
    case 'ReadPatch':
      return label(summaryWithPath('review patch', stringArg(args, 'path')), readPatchDetail(args, display));
    case 'ReadFileVersion':
      return label(
        summaryWithPath('file version', stringArg(args, 'path')),
        readFileVersionDetail(args, display),
      );
    case 'UpdateProgress': {
      const status = stringArg(args, 'status');
      return label(
        status === undefined ? 'review progress update' : `review progress update: ${status}`,
        joinDetails([
          stringArg(args, 'summary'),
          prefixed('blocker', stringArg(args, 'blocker')),
        ]) ?? displayDetail(display),
      );
    }
    case 'AddComment':
      return label(
        summaryWithPathLine('review comment', stringArg(args, 'path'), numberArg(args, 'line')),
        joinDetails([stringArg(args, 'severity'), stringArg(args, 'title')]) ?? displayDetail(display),
      );
    case 'GetComments':
      return label('review comments', commentsDetail(args, display));
    case 'GetCommentEvidence':
      return label(summaryWithPath('comment evidence', stringArg(args, 'comment_id')));
    case 'MergeComments':
      return label(
        summaryWithPathLine('comment merge', stringArg(args, 'path'), numberArg(args, 'line')),
        mergeDetail(args, display),
      );
    case 'DismissComment':
      return label(
        summaryWithPath('comment dismissal', stringArg(args, 'comment_id')),
        joinDetails([
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

function summaryWithPath(prefix: string, path: string | undefined): string {
  if (path === undefined || path.length === 0) return prefix;
  return `${prefix}: ${path}`;
}

function summaryWithPathLine(
  prefix: string,
  path: string | undefined,
  line: number | undefined,
): string {
  if (path === undefined || path.length === 0) return prefix;
  if (line === undefined) return `${prefix}: ${path}`;
  return `${prefix}: ${path}:${String(line)}`;
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

function readPatchDetail(
  args: Record<string, unknown>,
  display: ToolInputDisplay | undefined,
): string | undefined {
  const hasPatchArgs =
    stringArg(args, 'path') !== undefined ||
    stringArg(args, 'hunk_id') !== undefined ||
    numberArg(args, 'context_lines') !== undefined;
  if (!hasPatchArgs) return displayDetail(display);
  const contextLines = numberArg(args, 'context_lines') ?? 3;
  return joinDetails([
    stringArg(args, 'hunk_id') === undefined ? 'all hunks' : `hunk ${stringArg(args, 'hunk_id')}`,
    countLabel(contextLines, 'context line', 'context lines'),
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
  const source = ref === undefined
    ? stringArg(args, 'version') ?? 'current'
    : `ref ${formatReviewRefForLabel(ref)}`;
  return joinDetails([source, lineRangeLabel(numberArg(args, 'line_offset'), numberArg(args, 'n_lines'))]);
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
    sources === undefined ? undefined : countLabel(sources.length, 'source comment', 'source comments'),
    stringArg(args, 'severity'),
    stringArg(args, 'title'),
  ]) ?? displayDetail(display);
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

function joinDetails(parts: readonly (string | undefined)[]): string | undefined {
  const compact = parts.filter((part): part is string => part !== undefined && part.length > 0);
  if (compact.length === 0) return undefined;
  return compact.join(' · ');
}

function prefixed(prefix: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${prefix}: ${value}`;
}

function formatReviewRefForLabel(ref: string): string {
  return FULL_GIT_OBJECT_ID_RE.test(ref) ? ref.slice(0, SHORT_GIT_OBJECT_ID_LENGTH) : ref;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function lineRangeLabel(lineOffset: number | undefined, nLines: number | undefined): string {
  const start = lineOffset ?? 1;
  if (nLines === undefined) return `from line ${String(start)}`;
  if (nLines === 1) return `line ${String(start)}`;
  return `lines ${String(start)}-${String(start + nLines - 1)}`;
}
