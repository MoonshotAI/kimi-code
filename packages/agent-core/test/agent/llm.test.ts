import {
  emptyUsage,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type GenerateResult,
  type Message,
  type ModelCapability,
  type ProviderRequestAuth,
} from '@moonshot-ai/kosong';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { LlmService, type LlmServiceConfig, type LlmServiceDeps } from '../../src/agent/llm';
import { LlmRequestLogger } from '../../src/agent/llm-request-logger';
import { KosongLLM } from '../../src/agent/turn/kosong-llm';
import type { KimiConfig } from '../../src/config';
import type { Logger } from '#/_base/logging';
import type { ModelProvider } from '../../src/session/provider-manager';

interface TestDeps extends LlmServiceDeps {
  readonly rawGenerate: Mock<typeof import('@moonshot-ai/kosong').generate>;
}

function createLogger(): Logger {
  const logger: Logger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    createChild: () => logger,
  };
  return logger;
}

function makeProvider(modelName = 'test-model'): ChatProvider {
  return {
    name: 'test',
    modelName,
    thinkingEffort: null,
    generate: vi.fn<ChatProvider['generate']>(),
    withThinking() {
      return this;
    },
  };
}

function makeConfig(overrides: Partial<LlmServiceConfig> = {}): LlmServiceConfig {
  return {
    modelAlias: undefined,
    provider: makeProvider(),
    maxOutputSize: undefined,
    systemPrompt: 'system prompt',
    modelCapabilities: UNKNOWN_CAPABILITY,
    ...overrides,
  };
}

function makeGenerateResult(): GenerateResult {
  return {
    id: 'resp-1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      toolCalls: [],
    },
    usage: emptyUsage(),
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function makeDeps(overrides: Partial<LlmServiceDeps> = {}): TestDeps {
  const logger = createLogger();
  return {
    config: makeConfig(),
    llmRequestLogger: new LlmRequestLogger(logger),
    rawGenerate: vi.fn<typeof import('@moonshot-ai/kosong').generate>().mockResolvedValue(
      makeGenerateResult(),
    ),
    modelProvider: undefined,
    log: logger,
    kimiConfig: undefined,
    ...overrides,
  } as TestDeps;
}

describe('LlmService.generate', () => {
  it('wraps each call with llmRequestLogger.logRequest before invoking rawGenerate', async () => {
    const deps = makeDeps();
    const logRequest = vi.spyOn(deps.llmRequestLogger, 'logRequest');
    const service = new LlmService(deps);
    const provider = makeProvider('model-a');
    const history: Message[] = [];

    await service.generate(provider, 'sys', [], history, undefined, undefined);

    expect(logRequest).toHaveBeenCalledTimes(1);
    expect(logRequest).toHaveBeenCalledWith({
      provider,
      modelAlias: undefined,
      systemPrompt: 'sys',
      tools: [],
      messages: history,
      fields: undefined,
    });
    expect(deps.rawGenerate).toHaveBeenCalledTimes(1);
    expect(deps.rawGenerate).toHaveBeenCalledWith(provider, 'sys', [], history, undefined, undefined);
  });

  it('resolves request-scoped auth via modelProvider.resolveAuth when modelAlias is set and no auth in options', async () => {
    const injectedAuth: ProviderRequestAuth = { apiKey: 'resolved-token' };
    const authorizedRequest = <T>(request: (auth: ProviderRequestAuth) => Promise<T>): Promise<T> =>
      request(injectedAuth);
    const resolveAuth = vi.fn<NonNullable<ModelProvider['resolveAuth']>>().mockReturnValue(
      authorizedRequest,
    );
    const modelProvider: ModelProvider = {
      resolveProviderConfig: vi.fn(),
      resolveAuth,
    };
    const deps = makeDeps({
      config: makeConfig({ modelAlias: 'kimi-code' }),
      modelProvider,
    });
    const service = new LlmService(deps);
    const provider = makeProvider();

    await service.generate(provider, 'sys', [], [], undefined, {});

    expect(resolveAuth).toHaveBeenCalledTimes(1);
    expect(resolveAuth).toHaveBeenCalledWith('kimi-code', { log: deps.log });
    expect(deps.rawGenerate).toHaveBeenCalledTimes(1);
    const options = deps.rawGenerate.mock.calls[0]?.[5];
    expect(options).toMatchObject({ auth: injectedAuth });
  });

  it('skips auth resolution when options already carry auth', async () => {
    const resolveAuth = vi.fn<NonNullable<ModelProvider['resolveAuth']>>();
    const modelProvider: ModelProvider = {
      resolveProviderConfig: vi.fn(),
      resolveAuth,
    };
    const deps = makeDeps({
      config: makeConfig({ modelAlias: 'kimi-code' }),
      modelProvider,
    });
    const service = new LlmService(deps);
    const explicitAuth: ProviderRequestAuth = { apiKey: 'caller-supplied' };

    await service.generate(makeProvider(), 'sys', [], [], undefined, { auth: explicitAuth });

    expect(resolveAuth).not.toHaveBeenCalled();
    const options = deps.rawGenerate.mock.calls[0]?.[5];
    expect(options).toMatchObject({ auth: explicitAuth });
  });
});

describe('LlmService.llm', () => {
  it('constructs a KosongLLM with the resolved provider, system prompt, and capability', () => {
    const capability: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 200_000,
    };
    const provider = makeProvider('kimi-for-coding');
    const kimiConfig: KimiConfig = {
      providers: {},
      loopControl: { reservedContextSize: 4096 },
    };
    const deps = makeDeps({
      config: makeConfig({
        provider,
        systemPrompt: 'you are helpful',
        modelCapabilities: capability,
        maxOutputSize: 8192,
      }),
      kimiConfig,
    });
    const service = new LlmService(deps);

    const llm = service.llm;

    expect(llm).toBeInstanceOf(KosongLLM);
    expect(llm.systemPrompt).toBe('you are helpful');
    expect(llm.modelName).toBe('kimi-for-coding');
    expect(llm.capability).toBe(capability);
  });
});
