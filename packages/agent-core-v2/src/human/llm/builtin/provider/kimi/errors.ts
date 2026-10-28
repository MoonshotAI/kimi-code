import { headersToRecord, parseRetryAfterMs } from '#/llm/protocol/kit/http';
import type { LlmRemoteErrorMessage } from '#/llm/response';

const KIMI_QUOTA_EXHAUSTED_ERROR_CODES = new Set(['exceeded_current_quota_error']);

function readStringProp(value: object, key: string): string | undefined {
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : undefined;
}

function readErrorObjectProp(value: object): object | undefined {
  const raw = (value as Record<string, unknown>)['error'];
  return typeof raw === 'object' && raw !== null ? raw : undefined;
}

function collectErrorCodes(error: object): string[] {
  const codes: string[] = [];
  let current: object | undefined = error;
  for (let depth = 0; current !== undefined && depth < 3; depth += 1) {
    const code = readStringProp(current, 'code');
    if (code !== undefined) codes.push(code);
    const type = readStringProp(current, 'type');
    if (type !== undefined) codes.push(type);
    current = readErrorObjectProp(current);
  }
  return codes;
}

export function classifyKimiQuotaError(error: unknown): LlmRemoteErrorMessage | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as Record<string, unknown>)['status'];
  if (status !== 429 && status !== undefined) return undefined;

  const structuredHit = collectErrorCodes(error).some((code) =>
    KIMI_QUOTA_EXHAUSTED_ERROR_CODES.has(code),
  );
  if (!structuredHit) return undefined;

  const nestedError = readErrorObjectProp(error);
  const nestedMessage = nestedError === undefined ? undefined : readStringProp(nestedError, 'message');
  const anthropicError = nestedError === undefined ? undefined : readErrorObjectProp(nestedError);
  const message =
    nestedMessage ??
    (anthropicError === undefined ? '' : (readStringProp(anthropicError, 'message') ?? ''));
  const requestId = readStringProp(error, 'requestID') ?? null;
  const headers = (error as Record<string, unknown>)['headers'];
  return {
    kind: 'quota_exhausted',
    message,
    statusCode: status,
    requestId,
    retryAfterMs: parseRetryAfterMs(headers),
    headers: headersToRecord(headers),
  };
}
