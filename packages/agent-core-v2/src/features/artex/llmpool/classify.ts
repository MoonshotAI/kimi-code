import { isUserCancellation } from '#/_base/utils/abort';
import { isAbortError } from '@moonshot-ai/core/llm/protocol/errors';
import { isQuotaExhaustedMessage } from '@moonshot-ai/core/llm/protocol/rules/status';
import {
  llmStatusErrorMessage,
  type LlmErrorMessage,
  type LlmOutcome,
  type LlmRunEvent,
} from '@moonshot-ai/core/llm/response';

const STATUS_CODE_RE = /\b(?:status(?:\s+code)?|http(?:\s+status)?)\s*[=:]?\s*(\d{3})\b/i;

export function isLlmErrorMessageValue(value: unknown): value is LlmErrorMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

export function extractLlmFailure(error: unknown): {
  readonly llmError?: LlmErrorMessage;
  readonly statusCode?: number;
  readonly message: string;
} {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'failed' &&
    isLlmErrorMessageValue((error as { error?: unknown }).error)
  ) {
    const failed = error as Extract<LlmOutcome, { type: 'failed' }>;
    const statusCode = llmStatusErrorMessage(failed.error)?.statusCode;
    return {
      llmError: failed.error,
      statusCode,
      message: failed.error.message,
    };
  }
  if (isLlmErrorMessageValue(error)) {
    return {
      llmError: error,
      statusCode: llmStatusErrorMessage(error)?.statusCode,
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const directStatus = record['statusCode'] ?? record['status'];
    if (typeof directStatus === 'number') {
      return { statusCode: directStatus, message };
    }
  }
  const match = STATUS_CODE_RE.exec(message);
  const parsed = match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
  return {
    statusCode: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    message,
  };
}

export function shouldFailoverLlmError(error: unknown, signal?: AbortSignal): boolean {
  if (error === undefined || error === null) return false;
  if (signal?.aborted === true) return false;
  if (isAbortError(error) || isUserCancellation(error)) return false;

  const { llmError, statusCode } = extractLlmFailure(error);
  if (llmError !== undefined) {
    switch (llmError.kind) {
      case 'abort':
      case 'syntax':
      case 'context_overflow':
      case 'request_too_large':
      case 'request_structure':
      case 'image_format':
        return false;
      case 'auth':
      case 'quota_exhausted':
      case 'rate_limit':
      case 'overloaded':
      case 'timeout':
      case 'connection':
      case 'provider':
        return true;
      case 'empty_response':
        return llmError.retryable;
      case 'status':
      case 'unknown':
        break;
      default: {
        const exhaustive: never = llmError;
        return Boolean(exhaustive);
      }
    }
  }

  if (statusCode === undefined || statusCode === 0) {
    return true;
  }
  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    return false;
  }
  if (
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode >= 500
  ) {
    return true;
  }
  return false;
}

export function isHardLlmFailure(error: unknown): boolean {
  const { llmError, statusCode, message } = extractLlmFailure(error);
  if (llmError !== undefined) {
    switch (llmError.kind) {
      case 'auth':
      case 'quota_exhausted':
        return true;
      case 'rate_limit':
      case 'overloaded':
      case 'timeout':
      case 'connection':
      case 'empty_response':
      case 'provider':
      case 'syntax':
      case 'abort':
      case 'context_overflow':
      case 'request_too_large':
      case 'request_structure':
      case 'image_format':
      case 'status':
      case 'unknown':
        break;
      default: {
        const exhaustive: never = llmError;
        return Boolean(exhaustive);
      }
    }
  }
  if (statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 404) {
    return true;
  }
  return statusCode === 429 && isQuotaExhaustedMessage(message);
}

export function trimLlmErrorMessage(error: unknown): string {
  const { message } = extractLlmFailure(error);
  const singleLine = message.replaceAll('\n', ' ').trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine;
}

export function isLlmRunOutputEvent(event: LlmRunEvent): boolean {
  return event.type === 'llm.streaming.part';
}

export function extractLlmRunTerminalError(
  event: LlmRunEvent,
): Extract<LlmOutcome, { type: 'failed' }> | undefined {
  if (event.type === 'llm.ended' && event.outcome.type === 'failed') {
    return event.outcome;
  }
  return undefined;
}
