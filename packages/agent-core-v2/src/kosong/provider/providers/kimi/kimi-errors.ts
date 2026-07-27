/**
 * `kosong/provider` domain (L2) — Kimi vendor error classification, declared
 * on the Kimi traits via the `convertError` hook.
 *
 * This module owns the vendor-specific knowledge of how the Moonshot backend
 * signals quota/balance exhaustion on a 429: the structured body
 * `error.type`/`error.code` value `exceeded_current_quota_error`, and the
 * observed billing wordings for gateways that flatten the body to text
 * ("You exceeded your current token quota: … please check your account
 * balance", "Your account … is suspended due to insufficient balance, please
 * recharge your account …", and arrears phrasing). Every pattern is anchored
 * to billing wording — deliberately no bare /quota/ or /balance/, so
 * transient throttle messages like "token quota per minute" keep classifying
 * as retryable rate limits. The classifier reads the raw SDK error
 * structurally (status / code / type / message), so it works over both the
 * OpenAI and Anthropic transports Kimi registers on; anything it does not
 * positively recognize answers `undefined`, keeping the base classification.
 */

import {
  APIProviderQuotaExhaustedError,
  parseRetryAfterMs,
  parseTraceId,
} from '#/kosong/contract/errors';

const KIMI_QUOTA_EXHAUSTED_ERROR_CODES = new Set(['exceeded_current_quota_error']);

const KIMI_QUOTA_EXHAUSTED_MESSAGE_PATTERNS = [
  /exceeded your current (?:token )?quota/,
  /check your account balance/,
  /insufficient balance/,
  /recharge your account|please recharge/,
  /account (?:is )?in arrears/,
] as const;

function readStringProp(value: object, key: string): string | undefined {
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : undefined;
}

export function classifyKimiQuotaError(error: unknown): APIProviderQuotaExhaustedError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as Record<string, unknown>)['status'];
  if (status !== 429) return undefined;

  const message = readStringProp(error, 'message') ?? '';
  const code = readStringProp(error, 'code');
  const type = readStringProp(error, 'type');

  const structuredHit =
    (code !== undefined && KIMI_QUOTA_EXHAUSTED_ERROR_CODES.has(code)) ||
    (type !== undefined && KIMI_QUOTA_EXHAUSTED_ERROR_CODES.has(type));
  const lowerMessage = message.toLowerCase();
  const wordingHit = KIMI_QUOTA_EXHAUSTED_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(lowerMessage),
  );
  if (!structuredHit && !wordingHit) return undefined;

  const requestId = readStringProp(error, 'requestID') ?? null;
  const headers = (error as Record<string, unknown>)['headers'];
  return new APIProviderQuotaExhaustedError(
    message,
    requestId,
    parseRetryAfterMs(headers),
    parseTraceId(headers),
  );
}
