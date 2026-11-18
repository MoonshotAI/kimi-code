import { ErrorCode } from '../../protocol/error-codes';

export class WorktreeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export function stateInvalid(message: string): WorktreeError {
  return new WorktreeError(ErrorCode.WORKTREE_STATE_INVALID, message);
}
