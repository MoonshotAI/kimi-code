/**
 * `tool` domain (L3) — tool-call arguments parsing.
 *
 * Decodes the provider's raw `arguments` payload into a plain value. A
 * payload that fails JSON parsing is normalized to `{}` and flagged with
 * `parseFailed`, so callers can tell "the model sent an empty object" apart
 * from "the model sent malformed text". Pure helper; no scoped service.
 */

export function parseToolCallArguments(raw: unknown): {
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
} {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.length === 0)) {
    return { data: {}, parseFailed: false };
  }
  if (typeof raw !== 'string') {
    return { data: raw, parseFailed: false };
  }
  try {
    return { data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    return {
      data: {},
      parseFailed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
