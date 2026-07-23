import type { PasswordHandler, PasswordResult } from '@moonshot-ai/kimi-code-sdk';

import { adaptPasswordRequest } from './adapter';
import type { PasswordController } from './controller';

export function createPasswordRequestHandler(controller: PasswordController): PasswordHandler {
  return async (request): Promise<PasswordResult> => {
    try {
      return await controller.show(adaptPasswordRequest(request));
    } catch {
      return { kind: 'cancelled' };
    }
  };
}
