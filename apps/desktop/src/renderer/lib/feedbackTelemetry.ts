import {
  isDaemonApiError,
  isDaemonNetworkError,
  isDaemonTimeoutError,
  KIMI_AUTH_REJECTED_CODE,
  KIMI_AUTH_REQUIRED_CODE,
} from '@moonshot-ai/app-core/api';
import { ErrorCode } from '@moonshot-ai/kap-server/protocol/error-codes';
import { track } from './track';

export interface FeedbackClientFailure {
  readonly error_class: string;
  readonly error_code?: string;
  readonly http_status?: number;
}

export function classifyFeedbackClientError(error: unknown, signal?: AbortSignal): FeedbackClientFailure {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return { error_class: 'aborted' };
  }
  if (isDaemonApiError(error)) {
    return {
      error_class: feedbackApiErrorClass(error.code),
      ...(error.code === undefined ? {} : { error_code: String(error.code) }),
    };
  }
  if (isDaemonNetworkError(error)) {
    return {
      error_class: isDaemonTimeoutError(error) ? 'timeout' : 'network',
      ...(error.status === undefined ? {} : { http_status: error.status }),
    };
  }
  return { error_class: 'unknown' };
}

const apiErrorClasses: Readonly<Record<number, string>> = {
  [KIMI_AUTH_REQUIRED_CODE]: 'auth_required',
  [KIMI_AUTH_REJECTED_CODE]: 'access_denied',
  [ErrorCode.FILE_TOO_LARGE]: 'file_too_large',
  [ErrorCode.SESSION_NOT_FOUND]: 'session_not_found',
  [ErrorCode.FEEDBACK_REJECTED]: 'feedback_rejected',
  [ErrorCode.VALIDATION_FAILED]: 'validation_failed',
};

function feedbackApiErrorClass(code: number | undefined): string {
  return (code === undefined ? undefined : apiErrorClasses[code]) ?? 'api';
}

const mediaValidationErrors: Record<string, string> = {
  'feedback.mediaType': 'invalid_type',
  'feedback.emptyMedia': 'empty_file',
  'feedback.mediaCount': 'too_many_files',
  'feedback.videoCount': 'too_many_videos',
  'feedback.imageSize': 'file_too_large',
  'feedback.videoSize': 'file_too_large',
};

export function trackFeedbackMediaValidation(errors: readonly string[], files: FileList, sessionId?: string): void {
  if (errors.length === 0) return;
  const selected = Array.from(files);
  const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
  const mediaKind = selected.every(file => file.type.startsWith('image/')) ? ('image' as const)
    : selected.every(file => file.type.startsWith('video/')) ? ('video' as const) : undefined;
  for (const key of new Set(errors)) {
    track('feedback_attachment_upload', {
      emitter: 'client',
      attachment_kind: 'media',
      stage: 'validation',
      outcome: 'validation_rejected',
      duration_ms: 0,
      attempt: 'initial',
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(mediaKind === undefined ? {} : { media_kind: mediaKind }),
      size_bytes: totalBytes,
      error_class: mediaValidationErrors[key] ?? 'validation_failed',
    });
  }
}
