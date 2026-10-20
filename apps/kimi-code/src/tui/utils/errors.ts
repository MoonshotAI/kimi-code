function isAbortMessage(message: string): boolean {
  return message === 'Aborted' || message.endsWith(': Aborted');
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || isAbortMessage(error.message);
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    return typeof message === 'string' && isAbortMessage(message);
  }
  return isAbortMessage(String(error));
}
