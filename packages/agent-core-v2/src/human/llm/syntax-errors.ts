import type { LlmErrorMessage } from '#/llm/errors';

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
