import { ErrorCode } from '../../protocol/error-codes';
import { ProtocolError } from '../../transport/errors';

export class WorktreeError extends ProtocolError {
  override readonly name = 'WorktreeError';
}

export function stateInvalid(message: string): WorktreeError {
  return new WorktreeError(ErrorCode.WORKTREE_STATE_INVALID, message);
}
