/**
 * Render thrown values as human-readable lines for logs and CLI output.
 */

import { isCancellationError } from './errors';
import { isCodedError } from './serialize';

export function toErrorMessage(error: unknown, verbose = false): string {
  if (isCancellationError(error)) {
    return '';
  }
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
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
