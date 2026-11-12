import { isCodedError } from './serialize';

export function toErrorMessage(error: unknown, verbose = false): string {
  if (isCodedError(error)) {
    const base = `[${error.code}] ${error.message}`;
    return verbose && error.details ? `${base} ${JSON.stringify(error.details)}` : base;
  }
  if (error instanceof Error) {
    const base = error.message || error.name;
    if (verbose && error.cause !== undefined) {
      return `${base} (caused by: ${toErrorMessage(error.cause)})`;
    }
    return base;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { readonly kind?: unknown }).kind === 'string' &&
    typeof (error as { readonly message?: unknown }).message === 'string'
  ) {
    return (error as { readonly message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
