import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm/response';

export class SyntaxRequestFormatError extends Error {
  toLlmErrorMessage(): LlmErrorMessage<'syntax'> {
    return { kind: 'syntax', code: 'request_format', message: this.message };
  }
}

export function toLlmSyntaxErrorMessage(error: unknown): LlmErrorMessage<'syntax'> {
  if (error instanceof SyntaxRequestFormatError) {
    return error.toLlmErrorMessage();
  }
  return {
    kind: 'syntax',
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

type ThinkingConfigErrorCode =
  | 'thinking-unsupported'
  | 'thinking-cannot-disable'
  | 'off-needs-offeffort'
  | 'effort-unsupported';

export class ThinkingConfigError extends SyntaxRequestFormatError {
  readonly code: ThinkingConfigErrorCode;

  constructor(code: ThinkingConfigErrorCode, message: string) {
    super(message);
    this.name = 'ThinkingConfigError';
    this.code = code;
  }

  override toLlmErrorMessage(): LlmErrorMessage<'syntax'> {
    return { kind: 'syntax', code: 'thinking_config', message: this.message };
  }
}

export function unresolvedMediaRefError(ref: string): SyntaxRequestFormatError {
  return new SyntaxRequestFormatError(
    `Unresolved media reference '${ref}': messages must be lowered before encoding`,
  );
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as object).constructor?.name === 'APIUserAbortError'
  );
}

function abortErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return 'The operation was aborted.';
}

export function errorText(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}

export function toLlmErrorMessage(error: unknown): LlmRemoteErrorMessage {
  try {
    if (isAbortError(error)) {
      return { kind: 'abort', message: abortErrorMessage(error) };
    }
  } catch {
    return { kind: 'unknown', message: errorText(error) };
  }
  return { kind: 'unknown', message: errorText(error) };
}
