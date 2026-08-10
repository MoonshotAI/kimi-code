/**
 * Local error surface — `isKimiError` + RPC error mapping, replacing the
 * `@moonshot-ai/kimi-code-sdk` import (G-1 vscode localization). The engine
 * RPC layer rejects with `KimiError` carrying the wire error code, matching
 * what `chat.handler` / `session-runtime` expect (`error.code` / message).
 */

/** A typed error with a wire error code (node-sdk `KimiError` parity). */
export class KimiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "KimiError";
  }
}

/** Whether `error` is a `KimiError` (type guard, node-sdk parity). */
export function isKimiError(error: unknown): error is KimiError {
  return error instanceof KimiError;
}

/** Map a JSON-RPC error payload onto a `KimiError`. */
export function toKimiError(error: unknown): KimiError {
  if (isKimiError(error)) return error;
  if (error instanceof Error) return new KimiError("internal", error.message, error);
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = typeof record["code"] === "string" ? (record["code"] as string) : "internal";
    const message =
      typeof record["message"] === "string" ? (record["message"] as string) : JSON.stringify(error);
    return new KimiError(code, message, error);
  }
  return new KimiError("internal", String(error), error);
}
