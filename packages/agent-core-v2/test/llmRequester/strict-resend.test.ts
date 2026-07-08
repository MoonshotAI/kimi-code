import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { AgentLLMRequesterService } from '#/agent/llmRequester/llmRequesterService';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { APIStatusError } from '#/app/llmProtocol/errors';
import { emptyUsage } from '#/app/llmProtocol/usage';
import type { Message } from '#/app/llmProtocol/message';
import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { LLMEvent, Model } from '#/app/model/modelInstance';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const capabilities: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
];

function createModel(calls: { value: number }): Model {
  const build = (): Model => ({
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities,
    maxContextSize: 1000,
    thinkingEffort: null,
    alwaysThinking: false,
    providerName: 'p',
    authProvider: { getAuth: async () => undefined },
    withThinking: () => build(),
    withMaxCompletionTokens: () => build(),
    withGenerationKwargs: () => build(),
    withProviderOptions: () => build(),
    withThinkingKeep: () => build(),
    request: async function* () {
      calls.value += 1;
      if (calls.value === 1) {
        throw new APIStatusError(400, 'messages: `tool_use` ids must be unique');
      }
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      };
    },
  });
  return build();
}

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function createService(
  model: Model,
  projector: Pick<IAgentContextProjectorService, 'project' | 'projectStrict'>,
) {
  const ix = disposables.add(new TestInstantiationService());
  const profile: Partial<IAgentProfileService> = {
    resolveModelContext: () => ({
      modelAlias: 'm',
      modelCapabilities: capabilities,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel: 'off',
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
    }),
    getProvider: () => model,
    getSystemPrompt: () => 'system',
    data: () => ({
      cwd: '',
      modelAlias: 'm',
      modelCapabilities: capabilities,
      thinkingLevel: 'off',
      systemPrompt: 'system',
    }),
    isToolActive: () => true,
  };
  const contextSize = {
    get: () => ({ size: 0, measured: 0, estimated: 0 }),
    measured: () => undefined,
  };
  const usage = { record: () => undefined };
  const context = { get: () => history };
  const tools = { list: () => [] };
  const config: Partial<IConfigService> = {
    get: (() => undefined) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetry = { track: () => undefined };

  ix.stub(IAgentContextMemoryService, context);
  ix.stub(IAgentContextProjectorService, projector);
  ix.stub(IAgentContextSizeService, contextSize);
  ix.stub(IAgentToolRegistryService, tools);
  ix.stub(IAgentProfileService, profile);
  ix.stub(IAgentUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.set(
    IAgentWireService,
    new SyncDescriptor(WireService, [{ logScope: 'wire', logKey: 'strict-resend' }]),
  );
  ix.set(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));

  return ix.get(IAgentLLMRequesterService);
}

describe('AgentLLMRequesterService strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strictCalls = 0;
    const service = createService(createModel(calls), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    const result = await service.request({ retry: { maxAttempts: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.usage).toEqual(emptyUsage());
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strictCalls).toBe(1);
  });

  it('does not resend for non-recoverable errors', async () => {
    const model = createModel({ value: 0 });
    Object.defineProperty(model, 'request', {
      value: async function* () {
        const events: LLMEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(401, 'unauthorized');
      },
    });
    Object.defineProperty(model, 'withMaxCompletionTokens', {
      value: () => model,
    });
    let strictCalls = 0;
    const service = createService(model, {
      project: (messages: readonly ContextMessage[]) => messages,
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    await expect(service.request({ retry: { maxAttempts: 1 } })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(strictCalls).toBe(0);
  });
});
