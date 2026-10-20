import { openBlobStore } from '#/blob/index';
import { memoryBlobBackend } from '#/blob/backend/memory';
import { createUserEntry, type UserMeta } from '#/history/message';
import type { App } from '#/app/index';
import type { RuntimeEvent } from '#/kernel/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '#/llm/message';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import type { LoopAck, Loop, LoopEmitted, LoopLlmRequester } from '#/loop/index';
import { createSession, type Agent, type Session } from '#/session/index';
import { memoryJournal } from '#/store/backend/memory';
import type { ToolExecutor } from '#/tool/index';
import { waitEvent, type WaitOpts } from '#/utils/wait';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

export function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

export function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

export function scriptedRequester(
  next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>,
): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

export function echoRequester(): LoopLlmRequester {
  return scriptedRequester((rest) => {
    const messages = rest.content?.messages ?? [];
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    return textOutcome(`echo:${text}`);
  });
}

export function hangingRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: (_rest, control) =>
      new Promise((_, reject) => {
        if (control.signal.aborted) {
          reject(control.signal.reason);
          return;
        }
        control.signal.addEventListener('abort', () => reject(control.signal.reason));
      }),
  };
  return self;
}

export const noopExecutor: ToolExecutor = {
  execute: async () => ({ content: [] }),
};

export function agentCaps(executor: ToolExecutor = noopExecutor, initial: LoopLlmRequester = echoRequester()) {
  let current = initial;
  return {
    executor,
    requester: () => current,
    use: (next: LoopLlmRequester) => {
      current = next;
    },
  };
}

export function testSession(logs: Map<string, string[]> = new Map()): Promise<Session> {
  return createSession({ id: 'test', journal: memoryJournal(logs), blobs: openBlobStore(memoryBlobBackend()) });
}

export function texts(agent: Agent): string[] {
  return agent.view.getState().messages.map((entry) => extractText(entry.message as never));
}

export function loopEvent<T extends LoopEmitted['type']>(
  loop: Loop,
  type: T,
  opts?: WaitOpts<LoopAck<T>>,
): Promise<LoopAck<T>> {
  return loop.wait(type, opts);
}

export function appEvent(app: App, type: string, opts?: WaitOpts<RuntimeEvent>): Promise<RuntimeEvent> {
  return app.wait(type, opts);
}
