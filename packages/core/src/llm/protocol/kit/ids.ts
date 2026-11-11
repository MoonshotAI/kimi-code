/**
 * Sanitizes tool call ids to provider-safe characters, with an optional length limit.
 */

const TOOL_CALL_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;

export function sanitizeToolCallId(id: string, maxLength?: number): string {
  const sanitized = id.replace(TOOL_CALL_ID_SAFE_CHARS, '_');
  return maxLength === undefined ? sanitized : sanitized.slice(0, maxLength);
}
