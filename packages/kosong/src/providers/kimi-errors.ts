import { APIProviderQuotaExhaustedError, parseRetryAfterMs, parseTraceId } from '#/errors';

// Structured error `type`/`code` value that means the Moonshot account's
// quota or balance is exhausted (as opposed to a transient rate limit): the
// backend sets `exceeded_current_quota_error` as the body `error.type`.
const KIMI_QUOTA_EXHAUSTED_ERROR_CODES = new Set(['exceeded_current_quota_error']);

// Message fallback for gateways that flatten the body to text, matched
// against the lowercased message of a 429. Every pattern is anchored to
// billing wording — deliberately no bare /quota/ or /balance/, which would
// also match transient throttle messages like "token quota per minute".
// Grounded in observed Moonshot bodies: "You exceeded your current token
// quota: ... please check your account balance" and "Your account ... is
// suspended due to insufficient balance, please recharge your account or
// check your plan and billing details".
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

/**
 * Classify a raw provider failure as Moonshot's quota/balance-exhausted 429,
 * or answer `undefined` to keep the base classification. This is the Kimi
 * vendor's error knowledge, kept out of the shared OpenAI conversion: the
 * Kimi provider (and the Kimi files client) passes it to
 * `convertOpenAIError` as the vendor hook, consulted after the abort guard
 * with the raw SDK error — the base conversion would otherwise drop the
 * SDK-parsed body `error.type`/`error.code` this reads.
 */
export function classifyKimiQuotaError(
  error: unknown,
): APIProviderQuotaExhaustedError | undefined {
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
