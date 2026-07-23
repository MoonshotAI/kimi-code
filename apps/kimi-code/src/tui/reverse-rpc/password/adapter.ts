import { randomUUID } from 'node:crypto';

import type { PasswordRequest } from '@moonshot-ai/kimi-code-sdk';

import type { PasswordDialogData } from '#/tui/reverse-rpc/types';

export function adaptPasswordRequest(request: PasswordRequest): PasswordDialogData {
  return {
    id: randomUUID(),
    prompt: request.prompt,
    command: request.command,
  };
}
