import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { ErrorCodes, errorInfo, isError2 } from '#/errors';

export interface ResumeFailure {
  readonly error: Error;
  readonly fingerprint: string;
  readonly nonRetryable: boolean;
}

export function resumeFingerprint(
  summary: Pick<
    SessionSummary,
    'workspaceId' | 'cwd' | 'environmentId' | 'environmentCwd'
  >,
): string {
  return JSON.stringify([
    summary.workspaceId,
    summary.cwd,
    summary.environmentId,
    summary.environmentCwd,
  ]);
}

export function resumeFailure(error: unknown, summary: SessionSummary | undefined): ResumeFailure {
  const normalized = error instanceof Error ? error : new Error('session resume failed');
  if (summary === undefined) return { error: normalized, fingerprint: '', nonRetryable: false };
  return {
    error: normalized,
    fingerprint: resumeFingerprint(summary),
    nonRetryable: isNonRetryableResumeError(error),
  };
}

function isNonRetryableResumeError(error: unknown): boolean {
  if (error instanceof EnvironmentError) {
    return error.code === 'environment.invalid_cwd' || error.code === 'environment.not_found';
  }
  if (!isError2(error) || errorInfo(error.code).retryable) return false;
  return error.code === ErrorCodes.FS_PATH_NOT_FOUND || error.code === ErrorCodes.WORKSPACE_NOT_FOUND;
}
