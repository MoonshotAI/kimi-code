import { CorruptFrameError } from './codec.js';

export type StorageErrorAction = 'rebuild' | 'transient';

export function classifyStorageError(error: unknown): StorageErrorAction {
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => classifyStorageError(inner) === 'rebuild')
      ? 'rebuild'
      : 'transient';
  }
  if (error instanceof SyntaxError || error instanceof CorruptFrameError) return 'rebuild';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'WAL_WRITE_DISABLED' || code === 'WAL_POISONED') return 'rebuild';
  return 'transient';
}
