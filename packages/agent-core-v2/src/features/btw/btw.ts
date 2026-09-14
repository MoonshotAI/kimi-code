import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const BTW_READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

export const TOOL_CALL_DISABLED_MESSAGE =
  'Only the read-only tools Read, Grep, and Glob are available for side questions. Other tool calls are disabled.';

export const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- You may use the read-only tools Read, Grep, and Glob to inspect files when
  the answer depends on current file contents. All other tools are disabled
  and will be rejected, even though their definitions are visible in this
  request (they exist only for technical reasons — prompt cache).
- Prefer answering from what you already know from the conversation and this
  side-channel conversation; reach for the read-only tools only when needed.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`.trim();

export interface ISessionBtwService {
  readonly _serviceBrand: undefined;

  start(): Promise<string>;
}

export const ISessionBtwService: ServiceIdentifier<ISessionBtwService> =
  createDecorator<ISessionBtwService>('sessionBtwService');
