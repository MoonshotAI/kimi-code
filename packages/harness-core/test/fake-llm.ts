import {
  createAssistantMessage,
  type AgentLlmRequester,
  type LlmErrorMessage,
  type LlmModelSpec,
  type LlmOutcome,
  type LlmRequestModel,
  type LlmRequestPart,
  type LlmRunEvent,
  type LlmStatusErrorInfo,
  type ToolCall,
} from '@moonshot-ai/agent-core';

export const testModelSpec: LlmModelSpec = { provider: 'test', name: 'test-model' };

export const testModel: LlmRequestModel = { spec: testModelSpec };

export type FakeReply = (
  rest: LlmRequestPart,
  onEvent: ((event: LlmRunEvent) => void) | undefined,
) => LlmOutcome | Promise<LlmOutcome>;

export function fakeRequester(reply: FakeReply): AgentLlmRequester {
  const requester: AgentLlmRequester = {
    with: () => requester,
    request: () => {
      throw new Error('fake requester cannot build wire requests');
    },
    generate: async (rest, control) => {
      const outcome = await reply(rest, control.onEvent);
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

const NO_STATUS: LlmStatusErrorInfo = {
  statusCode: 500,
  requestId: null,
  retryAfterMs: null,
  headers: null,
};

export function statusFailureOutcome(message: string, statusCode = 500): LlmOutcome {
  return failureOutcome({ kind: 'status', ...NO_STATUS, statusCode, message });
}
