import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2';
import { UploadPartHttpError, UploadPartTimeoutError } from '@moonshot-ai/agent-core-v2/app/auth/feedback/upload';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import { classifyFeedbackUploadError, FeedbackError, feedbackSizeBucket } from '../src/services/feedback/feedbackService';

describe('feedback upload telemetry classification', () => {
  it('maps feedback errors to bounded categories while keeping upstream HTTP status', () => {
    expect(classifyFeedbackUploadError(new FeedbackError(ErrorCode.AUTH_TOKEN_MISSING, 'Sign in with secret token'))).toEqual({
      error_class: 'auth_required', error_code: '40111',
    });
    expect(classifyFeedbackUploadError(new FeedbackError(ErrorCode.AUTH_TOKEN_UNAUTHORIZED, 'Denied', 403))).toEqual({
      error_class: 'access_denied', error_code: '40112', http_status: 403,
    });
    expect(classifyFeedbackUploadError(new FeedbackError(ErrorCode.FILE_TOO_LARGE, 'Too large', 413))).toEqual({
      error_class: 'file_too_large', error_code: '41301', http_status: 413,
    });
    expect(classifyFeedbackUploadError(new FeedbackError(ErrorCode.SESSION_NOT_FOUND, 'Missing /Users/alice/private'))).toEqual({
      error_class: 'session_not_found', error_code: '40401',
    });
    expect(classifyFeedbackUploadError(new FeedbackError(ErrorCode.FEEDBACK_REJECTED, 'Expired', 409))).toEqual({
      error_class: 'feedback_rejected', error_code: '40936', http_status: 409,
    });
    expect(classifyFeedbackUploadError(new FeedbackError(ErrorCode.INTERNAL_ERROR, 'Upstream body leaked', 502))).toEqual({
      error_class: 'internal', error_code: '50001', http_status: 502,
    });
  });

  it('classifies storage part HTTP errors, timeouts, aborts, and filesystem or TLS codes', () => {
    expect(classifyFeedbackUploadError(new UploadPartHttpError(2, 403, 'Private XML body with signed url'))).toEqual({
      error_class: 'http', http_status: 403,
    });
    expect(classifyFeedbackUploadError(new UploadPartTimeoutError(1))).toEqual({ error_class: 'timeout' });
    expect(classifyFeedbackUploadError(new DOMException('aborted', 'AbortError'))).toEqual({ error_class: 'aborted' });
    expect(classifyFeedbackUploadError(new Error2(ErrorCodes.SESSION_EXPORT_TOO_LARGE, 'file too large: /tmp/private'))).toEqual({
      error_class: 'file_too_large', error_code: ErrorCodes.SESSION_EXPORT_TOO_LARGE,
    });
    expect(classifyFeedbackUploadError(new Error2(ErrorCodes.FS_IS_DIRECTORY, 'not a file: /tmp/private'))).toEqual({
      error_class: 'fs', error_code: ErrorCodes.FS_IS_DIRECTORY,
    });
    expect(classifyFeedbackUploadError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toEqual({
      error_class: 'network', error_code: 'ECONNRESET',
    });
    expect(classifyFeedbackUploadError(new Error('unable to verify', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }))).toEqual({
      error_class: 'network', error_code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    expect(classifyFeedbackUploadError(Object.assign(new Error('disk full /Users/alice'), { code: 'ENOSPC' }))).toEqual({
      error_class: 'fs', error_code: 'ENOSPC',
    });
    expect(classifyFeedbackUploadError(new Error('unexpected'))).toEqual({ error_class: 'unknown' });
  });

  it('never carries raw messages, paths, URLs, or tokens into telemetry fields', () => {
    const sensitive = 'Bearer sk-example-token https://signed.example.test/session.zip /Users/alice/secret';
    const errors = [
      new FeedbackError(ErrorCode.INTERNAL_ERROR, sensitive, 500),
      new UploadPartHttpError(1, 403, sensitive),
      new Error(sensitive, { cause: { code: 'ECONNREFUSED' } }),
      new Error2(ErrorCodes.SESSION_NOT_FOUND, sensitive),
    ];
    for (const error of errors) {
      const serialized = JSON.stringify(classifyFeedbackUploadError(error));
      expect(serialized).not.toContain('sk-example-token');
      expect(serialized).not.toContain('signed.example.test');
      expect(serialized).not.toContain('/Users/alice');
    }
  });

  it('buckets archive sizes at the same boundaries used by client attachment metrics', () => {
    const mib = 1024 * 1024;
    expect(feedbackSizeBucket(0)).toBe('<1mb');
    expect(feedbackSizeBucket(mib - 1)).toBe('<1mb');
    expect(feedbackSizeBucket(mib)).toBe('1-10mb');
    expect(feedbackSizeBucket(10 * mib)).toBe('10-50mb');
    expect(feedbackSizeBucket(50 * mib)).toBe('50-100mb');
    expect(feedbackSizeBucket(100 * mib)).toBe('100-500mb');
    expect(feedbackSizeBucket(500 * mib)).toBe('100-500mb');
    expect(feedbackSizeBucket(500 * mib + 1)).toBe('500mb+');
  });
});
