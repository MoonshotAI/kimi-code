import { createAssistantMessage, type ToolCall } from '#/llm/message';
import type { LlmModelSpec, LlmRequestModel } from '#/llm/request';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';
import type {
  LlmErrorMessage,
  LlmOutcome,
  LlmRunEvent,
  LlmStatusErrorInfo,
} from '#/llm/response';
import type { AgentLlmRequester } from '#/agent-machine/llm-actor';

export const testModelSpec: LlmModelSpec = { provider: 'test', name: 'test-model' };

export const testModel: LlmRequestModel = { spec: testModelSpec };

export type FakeReply = (
  rest: LlmRequestPart,
  onEvent: ((event: LlmRunEvent) => void) | undefined,
) => LlmOutcome | Promise<LlmOutcome>;

export function fakeRequester(reply: FakeReply, base: LlmRequestPart = {}): AgentLlmRequester {
  const requester: AgentLlmRequester = {
    with: (part) =>
      fakeRequester(
        reply,
        mergeFields(
          base as Readonly<Record<string, unknown>>,
          part as Readonly<Record<string, unknown>>,
        ) as LlmRequestPart,
      ),
    request: () => {
      throw new Error('fake requester cannot build wire requests');
    },
    generate: async (rest, control) => {
      const merged = mergeFields(
        base as Readonly<Record<string, unknown>>,
        rest as Readonly<Record<string, unknown>>,
      ) as LlmRequestPart;
      const outcome = await reply(merged, control.onEvent);
      control.onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
  return requester;
}

export function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

export function failureOutcome(error: LlmErrorMessage, rawError?: unknown): LlmOutcome {
  return { type: 'failed', error, rawError };
}

const NO_STATUS: LlmStatusErrorInfo = { statusCode: 500, requestId: null, retryAfterMs: null, headers: null };

export function statusFailureOutcome(message: string, statusCode = 500): LlmOutcome {
  return failureOutcome({ kind: 'status', ...NO_STATUS, statusCode, message });
}
