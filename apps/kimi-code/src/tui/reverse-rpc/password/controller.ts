import type { PasswordResult } from '@moonshot-ai/kimi-code-sdk';

import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';
import type { PasswordDialogData } from '#/tui/reverse-rpc/types';

export class PasswordController extends ReverseRpcController<PasswordDialogData, PasswordResult> {
  protected createCancelResponse(_reason: string): PasswordResult {
    return { kind: 'cancelled' };
  }
}
