import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';

export const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`.trim();

export interface ISessionBtwService {
  readonly _serviceBrand: undefined;

  start(): Promise<string>;
}

export const ISessionBtwService: ServiceIdentifier<ISessionBtwService> =
  createDecorator<ISessionBtwService>('sessionBtwService');
