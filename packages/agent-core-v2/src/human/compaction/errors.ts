export type CompactErrorCode =
  | 'busy'
  | 'unknown-agent'
  | 'insufficient'
  | 'drift'
  | 'summary-failed'
  | 'aborted'
  | 'cancelled'
  | 'reset-timeout'
  | 'budget-blocked';

export class CompactError extends Error {
  readonly code: CompactErrorCode;

  constructor(code: CompactErrorCode, message: string) {
    super(message);
    this.name = 'CompactError';
    this.code = code;
  }
}

export function isContextOverflowError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { kind?: unknown }).kind === 'context_overflow';
}

export function isShrinkableSummaryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === 'context_overflow' || kind === 'empty_response';
}
