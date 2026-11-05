import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { Error2, ErrorCodes, errorInfo, isError2 } from '#/errors';

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

export function sessionWorkspaceUnavailable(error: unknown, sessionId: string): Error {
  if (!isNonRetryableResumeError(error)) {
    return error instanceof Error ? error : new Error('session resume failed');
  }
  if (isError2(error) && error.code === ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE) return error;
  const causeCode = isError2(error) || error instanceof EnvironmentError ? error.code : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  return new Error2(
    ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE,
    `session ${sessionId} workspace is unavailable: ${message}`,
    {
      cause: error,
      details: { cause_code: causeCode, retryable: false },
    },
  );
}

function isNonRetryableResumeError(error: unknown): boolean {
  if (error instanceof EnvironmentError) {
    return error.code === 'environment.invalid_cwd' || error.code === 'environment.not_found';
  }
  if (!isError2(error) || errorInfo(error.code).retryable) return false;
  return (
    error.code === ErrorCodes.FS_PATH_NOT_FOUND ||
    error.code === ErrorCodes.WORKSPACE_NOT_FOUND ||
    error.code === ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE
  );
}
