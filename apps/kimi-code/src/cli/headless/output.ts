import type {
  HeadlessApprovalStatus,
  HeadlessGoalStatus,
  HeadlessRunFiles,
  HeadlessRunState,
  HeadlessRunSummary,
  HeadlessWarning,
} from './status-file';

export interface HeadlessMetadataHeader {
  readonly type: 'headless.result';
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly turnId: number | null;
  readonly state: HeadlessRunState;
  readonly responseFormat: 'markdown' | 'files' | 'omitted';
  readonly responseOmitted: boolean;
  readonly resumeCommand: string | null;
  readonly summary: HeadlessRunSummary;
  readonly approval: HeadlessApprovalStatus | null;
  readonly goal: HeadlessGoalStatus | null;
  readonly warnings: readonly HeadlessWarning[];
  readonly files: HeadlessRunFiles;
  readonly error?: { readonly message: string };
}

export function formatHeadlessMetadataHeader(header: HeadlessMetadataHeader): string {
  const suffix = header.responseOmitted ? '\n' : '\n\n';
  return `${JSON.stringify(header)}${suffix}`;
}
