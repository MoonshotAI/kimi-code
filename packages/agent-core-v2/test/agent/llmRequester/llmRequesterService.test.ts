import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { AgentLoopRequester, KIMI_CODE_INFINITE_RETRY_ENV } from '#/agent/loop/requester';
import { createAgentMediaPolicy } from '#/agent/loop/mediaPolicy';
import { createMachineRequester } from '#/agent/loop/machine/requester';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  createTurnMachine,
  type AssistantEntry,
  type TurnEvent,
  type TurnInput,
  type TurnLlmEvent,
} from '#human/agent/turn';
import { UNKNOWN_CAPABILITY } from '#human/llm-requester/capability';
import { createOpenAIRequester } from '#human/llm-requester/factories';
import type { LlmModel } from '#human/llm-requester/model';
import type { LlmRequester } from '#human/llm-requester/requester';
import { createActor, emit, setup } from '#human/xstate2';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { shapeUnsupportedDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IConfigService } from '#/app/config/config';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
  ChatProviderError,
} from '#/llm-adapter/contract/errors';
import { emptyUsage, type TokenUsage } from '#human/llm-requester/usage';
import {
  isToolCall,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from '#human/llm/message';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { IModelService } from '#/llm-adapter/model/model';
import {
  generateModel,
  type ModelRequestEvent,
  type ModelRequestInput,
} from '#/llm-adapter/model/generate';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import {
  aRequesterFromModelEvents,
  coreRequesterFromA,
  type ModelEventRequester,
} from '../../harness/scripted-generate';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { WireRecord } from '#/wire/record';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

import {
  recordingWireLog,
  registerTestAgentWire,
  registerTestEventDispatcher,
} from '../../wire/stubs';

const turnHarnessModel: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
};

function createTurnHarness(requester: LlmRequester) {
  return setup({
    types: {
      input: {} as TurnInput,
      context: {} as { turnInput: TurnInput },
      events: {} as TurnEvent,
      emitted: {} as TurnLlmEvent,
    },
    actors: { turn: createTurnMachine(requester) },
  }).createMachine({
    id: 'turn-harness',
    initial: 'running',
    context: ({ input }) => ({ turnInput: input }),
    states: {
      running: {
        invoke: {
          src: 'turn',
          input: ({ context }) => context.turnInput,
          onDone: { target: 'completed' },
        },
        on: {
          '*': {
            actions: emit(({ event }) => event as TurnLlmEvent),
          },
        },
      },
      completed: { type: 'final' },
    },
  });
}

const capabilities: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

function createRequester(
  calls: { value: number },
  firstCallError?: Error | null,
  subsequentCallErrors: readonly Error[] = [],
  capturedInputs?: ModelRequestInput[],
): ModelEventRequester {
  const model: Model = {
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities,
    maxContextSize: 1000,
    alwaysThinking: false,
    providerName: 'p',
  };
  return {
    model,
    request: async function* (input) {
      calls.value += 1;
      capturedInputs?.push(input);
      const error =
        calls.value === 1
          ? firstCallError === null
            ? undefined
            : (firstCallError ??
              new APIStatusError(400, 'messages: `tool_use` ids must be unique'))
          : subsequentCallErrors[calls.value - 2];
      if (error !== undefined) throw error;
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      };
    },
  };
}

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function createService(
  requester: ModelEventRequester,
  options: {
    readonly thinkingLevel?: ThinkingEffort;
    readonly mediaResolver?: Partial<IAgentMediaResolverService>;
    readonly toolSelect?: Partial<IAgentToolSelectService>;
    readonly contextMessages?: ContextMessage[];
    readonly env?: Record<string, string>;
    readonly modelAlias?: () => string;
    readonly prefixRevision?: () => number;
  } = {},
) {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-code-llm-requester-test', options.env ?? {}));
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const profile: Partial<IAgentProfileService> = {
    hasProvider: () => true,
    resolveModelContext: () => ({
      modelAlias: options.modelAlias?.() ?? 'm',
      modelCapabilities: capabilities,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel,
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
      compactionMaxAttempts: undefined,
    }),
    resolveRequestParams: () => ({}),
    getSystemPrompt: () => 'system',
    data: () => ({
      cwd: '',
      modelAlias: 'm',
      modelCapabilities: capabilities,
      thinkingLevel,
      systemPrompt: 'system',
    }),
  };
  const measuredCalls: { readonly messages: number; readonly usage: TokenUsage }[] = [];
  const tokenCounting = {
    get: () => ({ size: 0, measured: 0, estimated: 0 }),
    measured: (
      _agent: AgentContext,
      input: readonly Message[],
      _output: readonly Message[],
      usage: TokenUsage,
    ) => {
      measuredCalls.push({ messages: input.length, usage });
    },
  };
  const usage = { record: () => Promise.resolve(), status: () => ({}) };
  const context = {
    get: () => options.contextMessages ?? history,
    prefixRevision: options.prefixRevision ?? (() => 0),
  };
  const config: Partial<IConfigService> = {
    get: (() => undefined) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetryRecords: TelemetryRecord[] = [];
  const telemetry = recordingTelemetry(telemetryRecords);
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    prepareForRequest: async () => {},
    defaultTools: () => [],
    shapeHistory: (messages) => messages,
    ...options.toolSelect,
  };
  const events: Event2[] = [];
  const eventBus: IEventBus = {
    _serviceBrand: undefined,
    publish: (event) => events.push(event),
    subscribe: () => toDisposable(() => {}),
  };

  const mediaResolver: IAgentMediaResolverService = {
    _serviceBrand: undefined,
    resolve: async (messages) => messages,
    displayPaths: async () => new Map(),
    ...options.mediaResolver,
  };
  ix.stub(IAgentContextMemoryService, context);
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentMediaResolverService, mediaResolver);
  ix.stub(ISessionTokenCountingService, tokenCounting);
  ix.stub(IAgentProfileService, profile);
  ix.stub(ISessionUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.stub(IModelCatalog, {
    _serviceBrand: undefined,
    get: () => requester.model,
    findByName: () => [],
  });
  ix.stub(IModelService, {
    get: () => undefined,
  });
  ix.stub(IProtocolAdapterRegistry, {
    request: (model, params) =>
      coreRequesterFromA(
        new ProtocolAdapterRegistry().request(model, params),
        aRequesterFromModelEvents({
          ...requester,
          request: (input, signal, requestOptions) =>
            requester.request(input, signal, { ...requestOptions, ...params }),
        }),
      ),
  } as IProtocolAdapterRegistry);
  const records: WireRecord[] = [];
  registerTestAgentWire(ix, 'wire/llm-requester', {
    log: recordingWireLog(records),
    eventBus,
  });
  registerTestEventDispatcher(ix);
  ix.set(IAgentStateService, new AgentStateService());
  const service = ix.createInstance(AgentLoopRequester);
  service.registerMediaPolicy((model, request) =>
    createAgentMediaPolicy(mediaResolver, model, request),
  );

  return {
    service,
    dispatcher: ix.get(IEventDispatcher),
    records,
    events,
    telemetry,
    telemetryRecords,
    measuredCalls,
  };
}

describe('AgentLoopRequester measured anchors', () => {
  it('skips the measured anchor when the stream reports no usage', async () => {
    const { service, measuredCalls } = createService(createRequester({ value: 0 }));

    await service.request();

    expect(measuredCalls).toHaveLength(0);
  });

  it('writes the measured anchor from the reported usage', async () => {
    const requester = createRequester({ value: 0 });
    const base = requester.request.bind(requester);
    requester.request = async function* (input, signal, options) {
      yield {
        type: 'usage',
        usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        model: 'wire-model',
      };
      yield* base(input, signal, options);
    };
    const { service, measuredCalls } = createService(requester);

    await service.request();

    expect(measuredCalls).toHaveLength(1);
    expect(measuredCalls[0]?.usage.inputOther).toBe(40);
  });
});

describe('AgentLoopRequester Anthropic effort diagnostics', () => {
  it('warns and sends when the effort is not listed by the model', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null);
    Object.defineProperty(requester.model, 'supportEfforts', { value: ['max'] });
    const { service, events } = createService(requester, { thinkingLevel: 'high' });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        type: 'warning',
        code: 'anthropic-thinking-effort-not-listed',
        message:
          'Thinking effort "high" is not listed for model "wire-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
      }),
    ]);
  });
});

describe('AgentLoopRequester strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const contextMessages: ContextMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'stale' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: '<tools_added>\nalpha\n</tools_added>' }],
        origin: { kind: 'system_trigger', name: 'loadable-tools' },
      },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const { service } = createService(createRequester(calls, undefined, [], inputs), {
      contextMessages,
      toolSelect: {
        defaultTools: () => [],
        shapeHistory: (messages) => shapeUnsupportedDynamicToolContext(messages),
      },
    });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.usage).toEqual(emptyUsage());
    expect(calls.value).toBe(2);
    expect(inputs.map((input) => input.messages.map((message) => message.role))).toEqual([
      ['assistant', 'user', 'user'],
      ['user', 'user'],
    ]);
  });

  it('does not resend for non-recoverable errors', async () => {
    const calls = { value: 0 };
    const { service } = createService(
      createRequester(calls, new APIStatusError(401, 'unauthorized')),
    );

    await expect(service.request()).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(calls.value).toBe(1);
  });
});

describe('AgentLoopRequester infinite retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries every request error while KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'), [
      new APIStatusError(404, 'model not found'),
      new APIConnectionError('socket hang up'),
      new APIProviderQuotaExhaustedError('quota exhausted'),
    ]);
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    const promise = service.request();
    await vi.runAllTimersAsync();
    const finish = await promise;

    expect(calls.value).toBe(5);
    expect(finish.message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('honors the provider retry-after delay while retrying indefinitely', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIProviderRateLimitError('slow down', null, 1));
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    const startedAt = Date.now();
    await service.request();

    expect(calls.value).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('stops retrying when the caller aborts during the backoff wait', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'));
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 100);

    const promise = service.request({}, undefined, controller.signal);
    const assertion = expect(promise).rejects.toThrow('stop');
    await vi.runAllTimersAsync();
    await assertion;

    expect(calls.value).toBe(1);
  });

  it('keeps deterministic projection recovery ahead of infinite retry', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIRequestTooLargeError(413, 'Request Entity Too Large'));
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    await service.request();

    expect(calls.value).toBe(2);
  });

  it('lets context overflow reach deterministic recovery instead of retrying', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(
      calls,
      new APIContextOverflowError(400, 'context length exceeded'),
    );
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    await expect(service.request()).rejects.toBeInstanceOf(APIContextOverflowError);
    expect(calls.value).toBe(1);
  });

  it('retries operation requests indefinitely', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'), [
      new APIStatusError(404, 'model not found'),
    ]);
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    const promise = service.request({
      source: { type: 'operation', requestKind: 'full_compaction' },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls.value).toBe(3);
  });

  it('does not retry when the switch is unset', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken'));
    const { service } = createService(requester);

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
  });
});

describe('AgentLoopRequester media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );
  const contextMessages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,IMAGE' } }],
    },
  ];

  function mediaCounts(inputs: readonly ModelRequestInput[]): number[] {
    return inputs.map(
      (input) =>
        input.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url').length,
    );
  }

  it('resends once with the media-stripped projection after an image-format rejection', async () => {
    for (const rejection of [
      IMAGE_FORMAT_400,
      new ChatProviderError('Unsupported media type for base64 image: image/avif'),
      new ChatProviderError('Invalid data URL for image: data:image/png;base64,AAAA'),
    ]) {
      const calls = { value: 0 };
      const inputs: ModelRequestInput[] = [];
      const { service } = createService(
        createRequester(calls, rejection, [], inputs),
        { contextMessages },
      );

      const result = await service.request();

      expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(calls.value).toBe(2);
      expect(mediaCounts(inputs)).toEqual([1, 0]);
    }
  });

  it('keeps later steps of the same turn on the stripped projection', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(
      createRequester(calls, IMAGE_FORMAT_400, [], inputs),
      { contextMessages },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([1, 0, 0]);
  });

  it('does not resend for an unrelated 400', async () => {
    const calls = { value: 0 };
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'some other validation problem')),
    );

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
  });

  it('warns the user when media are stripped from the retried request', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, events } = createService(
      createRequester(calls, IMAGE_FORMAT_400),
      { contextMessages },
    );

    await service.request();
    await dispatcher.flush();

    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        type: 'warning',
        code: 'media-stripped',
        message:
          'Provider rejected the media in the request; all media were omitted and the request was retried.',
      }),
    ]);
  });
});

describe('AgentLoopRequester media-degraded resend', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');

  function threeImages(): Message[] {
    return ['ONE', 'TWO', 'THREE'].map((data) => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${data}` } }],
    }));
  }

  function mediaCounts(inputs: readonly ModelRequestInput[]): number[] {
    return inputs.map(
      (input) =>
        input.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url').length,
    );
  }

  it('resends once with the media-degraded projection after an HTTP 413', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(
      createRequester(
        calls,
        new Error2(ErrorCodes.PROVIDER_API_ERROR, 'Provider request failed', {
          cause: BODY_TOO_LARGE_413,
        }),
        [],
        inputs,
      ),
      { contextMessages: threeImages() },
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(mediaCounts(inputs)).toEqual([3, 2]);
  });

  it('refreshes display paths for inherited degraded and stripped media', async () => {
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    let directory = '/session/media/first';
    const imageMessage = (url: string): Message => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url } }],
    });
    const messages = [
      imageMessage('kimi-file://f_old'),
      imageMessage('kimi-file://f_keep1'),
      imageMessage('kimi-file://f_keep2'),
    ];
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413], capturedInputs),
      {
        mediaResolver: {
          resolve: async (current) => current,
          displayPaths: async () =>
            new Map([
              ['kimi-file://f_old', `${directory}/f_old.png`],
              ['kimi-file://f_keep1', `${directory}/f_keep1.png`],
              ['kimi-file://f_keep2', `${directory}/f_keep2.png`],
            ]),
        },
      },
    );
    const textsAt = (index: number) =>
      capturedInputs[index]!.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text);

    await service.request({ messages, source: { type: 'turn', turnId: 1, step: 1 } });

    expect(calls.value).toBe(3);
    const degradedParts = capturedInputs[1]!.messages.flatMap((message) => message.content);
    const urls = degradedParts
      .filter((part) => part.type === 'image_url')
      .map((part) => mediaUrlOf(part));
    expect(urls).toEqual(['kimi-file://f_keep1', 'kimi-file://f_keep2']);
    expect(textsAt(1)).toContain('<image path="/session/media/first/f_old.png"></image>');
    expect(textsAt(2)).toEqual(
      expect.arrayContaining([
        '<image path="/session/media/first/f_old.png"></image>',
        '<image path="/session/media/first/f_keep1.png"></image>',
        '<image path="/session/media/first/f_keep2.png"></image>',
      ]),
    );

    directory = '/session/media/second';
    await service.request({ messages, source: { type: 'turn', turnId: 1, step: 2 } });

    expect(calls.value).toBe(4);
    const inheritedTexts = textsAt(3);
    expect(inheritedTexts).toEqual(
      expect.arrayContaining([
        '<image path="/session/media/second/f_old.png"></image>',
        '<image path="/session/media/second/f_keep1.png"></image>',
        '<image path="/session/media/second/f_keep2.png"></image>',
      ]),
    );
    expect(inheritedTexts.join('\n')).not.toContain('/session/media/first/');
  });

  it('falls back to media-stripped when the media-degraded request still receives 413', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413], inputs),
      { contextMessages: threeImages() },
    );

    const result = await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([3, 2, 0]);
  });

  it('records repeated-413 recovery projections on the sticky later request', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, records } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      { contextMessages: threeImages() },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await dispatcher.flush();

    expect(
      records
        .filter((record) => record.type === 'llm.request')
        .map((record) => record['projection']),
    ).toEqual([undefined, 'media-degraded', 'media-stripped', 'media-stripped']);
  });

  it('keeps new recovery media visible on later snapshot-stripped steps', async () => {
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    const oldUrl = 'data:image/png;base64,REJECTED';
    const newUrl = 'data:image/png;base64,SMALL';
    const imageMessage = (url: string, id: string): Message => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url, id } }],
    });
    const { service } = createService(
      createRequester(
        calls,
        BODY_TOO_LARGE_413,
        [BODY_TOO_LARGE_413],
        capturedInputs,
      ),
    );

    await service.request({
      messages: [imageMessage(oldUrl, 'rejected-id')],
      source: { type: 'turn', turnId: 1, step: 1 },
    });
    await service.request({
      messages: [
        imageMessage(oldUrl, 'rejected-id'),
        imageMessage(newUrl, 'recovery-id'),
      ],
      source: { type: 'turn', turnId: 1, step: 2 },
    });

    const visibleUrls = capturedInputs
      .at(-1)
      ?.messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url')
      .map((part) => mediaUrlOf(part));
    expect(visibleUrls).toEqual([newUrl]);
  });

  it('stops after the media-stripped request also receives 413', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413], inputs),
      { contextMessages: threeImages() },
    );

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toStrictEqual(BODY_TOO_LARGE_413);
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([3, 2, 0]);
  });

  it('keeps later steps of the same turn on the degraded projection', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [], inputs),
      { contextMessages: threeImages() },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([3, 2, 2]);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive'),
      new APIStatusError(422, 'unprocessable'),
    ]) {
      const calls = { value: 0 };
      const { service } = createService(createRequester(calls, error));

      await expect(service.request()).rejects.toStrictEqual(error);
      expect(calls.value).toBe(1);
    }
  });

  it('does not warn when the degraded projection leaves the request unchanged', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, events } = createService(
      createRequester(calls, BODY_TOO_LARGE_413),
    );

    await service.request();
    await dispatcher.flush();

    expect(calls.value).toBe(2);
    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
  });

  it('warns for each escalation when the degraded resend is also rejected as too large', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, events } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      { contextMessages: threeImages() },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await dispatcher.flush();

    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'media-degraded' }),
      expect.objectContaining({ type: 'warning', code: 'media-stripped' }),
    ]);
  });
});

describe('AgentLoopRequester media recovery prefix parity', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );
  const REJECTED_FORMAT_URL = 'data:image/avif;base64,REJECTED';
  const COMPACTION_INSTRUCTION = 'Summarize the conversation.';

  function imageMessage(url: string, id: string): Message {
    return {
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url, id } }],
    };
  }

  function textMessage(text: string): Message {
    return { role: 'user', content: [{ type: 'text', text }] };
  }

  function mediaRejectingRequester(inputs: ModelRequestInput[]): ModelEventRequester {
    const accepting = createRequester({ value: 0 }, null);
    return {
      model: accepting.model,
      request: async function* (input, signal, params) {
        inputs.push(input);
        const images = input.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url');
        if (images.some((part) => mediaUrlOf(part) === REJECTED_FORMAT_URL)) {
          throw IMAGE_FORMAT_400;
        }
        if (images.length > 2) throw BODY_TOO_LARGE_413;
        yield* accepting.request(input, signal, params);
      },
    };
  }

  function expectPrefixExtension(previous: ModelRequestInput, next: ModelRequestInput): void {
    expect(next.systemPrompt).toBe(previous.systemPrompt);
    expect(next.tools).toEqual(previous.tools);
    expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  }

  const degradedTurn = [
    imageMessage('data:image/png;base64,OLDEST', 'oldest'),
    imageMessage('data:image/png;base64,MIDDLE', 'middle'),
    imageMessage('data:image/png;base64,NEWEST', 'newest'),
  ];

  it('starts the next turn on the media-degraded projection the previous turn settled on', async () => {
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(mediaRejectingRequester(inputs));

    await service.request({ messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    expect(inputs).toHaveLength(2);
    const settled = inputs[1]!;

    await service.request({
      messages: [...degradedTurn, textMessage('next turn')],
      source: { type: 'turn', turnId: 2, step: 1 },
    });

    expectPrefixExtension(settled, inputs[2]!);
    expect(inputs).toHaveLength(3);
  });

  it('keeps the media-degraded prefix when a later turn adds new media', async () => {
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(
      createRequester({ value: 0 }, BODY_TOO_LARGE_413, [], inputs),
    );

    await service.request({ messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    expect(inputs).toHaveLength(2);
    const settled = inputs[1]!;

    await service.request({
      messages: [...degradedTurn, imageMessage('data:image/png;base64,FRESH', 'fresh')],
      source: { type: 'turn', turnId: 2, step: 1 },
    });

    expect(inputs).toHaveLength(3);
    expectPrefixExtension(settled, inputs[2]!);
  });

  it('re-degrades instead of stripping when new media push an inherited degraded request over the limit', async () => {
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(mediaRejectingRequester(inputs));

    await service.request({ messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({
      messages: [...degradedTurn, imageMessage('data:image/png;base64,FRESH', 'fresh')],
      source: { type: 'turn', turnId: 2, step: 1 },
    });

    expect(inputs).toHaveLength(4);
    expect(
      inputs[3]!.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url')
        .map((part) => part.imageUrl.url),
    ).toEqual(['data:image/png;base64,NEWEST', 'data:image/png;base64,FRESH']);
  });

  it.each([
    { rejection: 'image-format', added: [imageMessage(REJECTED_FORMAT_URL, 'new-rejected')] },
    { rejection: '413', added: degradedTurn },
  ])('recovers newly added media rejected with $rejection after a strip', async ({ added }) => {
    for (const source of [
      { type: 'turn', turnId: 2, step: 1 },
      { type: 'operation', turnId: 1, requestKind: 'full_compaction' },
      { type: 'operation', turnId: undefined, requestKind: 'full_compaction' },
    ] as const) {
      const inputs: ModelRequestInput[] = [];
      const { service } = createService(mediaRejectingRequester(inputs));
      const rejected = imageMessage(REJECTED_FORMAT_URL, 'rejected');

      await service.request({ messages: [rejected], source: { type: 'turn', turnId: 1, step: 1 } });
      expect(inputs).toHaveLength(2);

      await service.request({ messages: [rejected, ...added], source });

      expect(inputs).toHaveLength(4);
      expect(inputs[2]!.messages[0]).toEqual(inputs[1]!.messages[0]);
      expect(
        inputs[2]!.messages.flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url'),
      ).toEqual(added.flatMap((message) => message.content));
      expect(
        inputs[3]!.messages.flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url'),
      ).toEqual([]);

      await service.request({
        messages: [rejected, ...added, textMessage('next turn')],
        source: { type: 'turn', turnId: 3, step: 1 },
      });

      expect(inputs).toHaveLength(source.type === 'turn' ? 5 : 6);
      expect(
        inputs[4]!.messages.flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url'),
      ).toEqual(source.type === 'turn' ? [] : added.flatMap((message) => message.content));
      expectPrefixExtension(inputs[3]!, inputs.at(-1)!);
    }
  });

  it.each([
    { rejection: 'image-format', error: IMAGE_FORMAT_400 },
    { rejection: '413', error: BODY_TOO_LARGE_413 },
  ])('bounds $rejection recovery after inheriting a strip snapshot', async ({ error }) => {
    for (const hasNewMedia of [false, true]) {
      const inputs: ModelRequestInput[] = [];
      const requester = mediaRejectingRequester(inputs);
      const { service } = createService(requester);
      const rejected = imageMessage(REJECTED_FORMAT_URL, 'rejected');
      await service.request({ messages: [rejected], source: { type: 'turn', turnId: 1, step: 1 } });

      requester.request = createRequester({ value: 0 }, error, [error], inputs).request;
      const messages = hasNewMedia
        ? [rejected, imageMessage('data:image/png;base64,FRESH', 'fresh')]
        : [rejected];
      await expect(
        service.request({ messages, source: { type: 'turn', turnId: 2, step: 1 } }),
      ).rejects.toStrictEqual(error);

      expect(inputs).toHaveLength(hasNewMedia ? 4 : 3);
    }
  });

  it.each([
    { change: 'the history prefix is rewritten', bump: 'revision' },
    { change: 'the model changes', bump: 'model' },
  ] as const)('retries full media on the next turn after $change', async ({ bump }) => {
    let revision = 0;
    let modelAlias = 'm';
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(mediaRejectingRequester(inputs), {
      modelAlias: () => modelAlias,
      prefixRevision: () => revision,
    });

    await service.request({ messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    expect(inputs).toHaveLength(2);

    if (bump === 'revision') revision += 1;
    else modelAlias = 'other';
    await service.request({ messages: degradedTurn, source: { type: 'turn', turnId: 2, step: 1 } });

    expect(inputs).toHaveLength(4);
    expect(inputs[2]!.messages).toEqual(degradedTurn);
  });

  it.each([
    { trigger: 'auto', turnId: 1 },
    { trigger: 'manual', turnId: undefined },
  ])(
    'starts a $trigger compaction request on the media-degraded projection of the last turn',
    async ({ turnId }) => {
      const inputs: ModelRequestInput[] = [];
      const { service } = createService(mediaRejectingRequester(inputs));

      await service.request({ messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
      expect(inputs).toHaveLength(2);
      const settled = inputs[1]!;

      await service.request({
        messages: [...degradedTurn, textMessage(COMPACTION_INSTRUCTION)],
        source: { type: 'operation', turnId, requestKind: 'full_compaction' },
      });

      expectPrefixExtension(settled, inputs[2]!);
      expect(inputs).toHaveLength(3);
    },
  );

  it.each([
    { trigger: 'auto', turnId: 1 },
    { trigger: 'manual', turnId: undefined },
  ])(
    'keeps media added after the strip snapshot visible in a $trigger compaction request',
    async ({ turnId }) => {
      const inputs: ModelRequestInput[] = [];
      const { service } = createService(mediaRejectingRequester(inputs));
      const rejected = imageMessage(REJECTED_FORMAT_URL, 'rejected');
      const fresh = imageMessage('data:image/png;base64,FRESH', 'fresh');

      await service.request({ messages: [rejected], source: { type: 'turn', turnId: 1, step: 1 } });
      await service.request({
        messages: [rejected, fresh],
        source: { type: 'turn', turnId: 1, step: 2 },
      });
      expect(inputs).toHaveLength(3);
      const lastLoop = inputs[2]!;
      expect(
        lastLoop.messages.flatMap((message) => message.content).filter((part) => part.type === 'image_url'),
      ).toEqual(fresh.content);

      await service.request({
        messages: [rejected, fresh, textMessage(COMPACTION_INSTRUCTION)],
        source: { type: 'operation', turnId, requestKind: 'full_compaction' },
      });

      expectPrefixExtension(lastLoop, inputs[3]!);
      expect(inputs).toHaveLength(4);
    },
  );
});

describe('AgentLoopRequester combined recovery projections', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );
  const STRUCTURAL_400 = new APIStatusError(400, 'messages: `tool_use` ids must be unique');

  const contextMessages: Message[] = [
    { role: 'assistant', content: [{ type: 'text', text: 'stale' }], toolCalls: [] },
    {
      role: 'user',
      content: ['ONE', 'TWO', 'THREE'].map((data) => ({
        type: 'image_url',
        imageUrl: { url: `data:image/png;base64,${data}` },
      })),
    },
  ];

  it('accumulates media repairs on strict without persisting strict to the next step', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service, dispatcher, records } = createService(
      createRequester(calls, STRUCTURAL_400, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413], inputs),
      { contextMessages },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(calls.value).toBe(4);
    expect(inputs.map((input) => input.messages.map((message) => message.role))).toEqual([
      ['assistant', 'user'],
      ['user'],
      ['user'],
      ['user'],
    ]);
    await dispatcher.flush();
    expect(
      records.filter((record) => record.type === 'llm.request').map((record) => record['projection']),
    ).toEqual([undefined, 'strict', 'strict-media-degraded', 'strict-media-stripped']);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await dispatcher.flush();

    expect(calls.value).toBe(5);
    expect(inputs[4]?.messages.map((message) => message.role)).toEqual(['assistant', 'user']);
    expect(
      records.findLast((record) => record.type === 'llm.request')?.['projection'],
    ).toBe('media-stripped');
  });

  it('strips rejected images on top of strict after an image-format rejection on the strict resend', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service, dispatcher, records } = createService(
      createRequester(calls, STRUCTURAL_400, [IMAGE_FORMAT_400], inputs),
      { contextMessages },
    );

    await service.request();

    expect(calls.value).toBe(3);
    expect(
      inputs[2]?.messages.flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url'),
    ).toEqual([]);
    await dispatcher.flush();
    expect(
      records.filter((record) => record.type === 'llm.request').map((record) => record['projection']),
    ).toEqual([undefined, 'strict', 'strict-media-stripped']);
  });

  it('applies the strict repair on top of degraded media without repeating the media warning', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service, dispatcher, events, records } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [STRUCTURAL_400], inputs),
      { contextMessages },
    );

    await service.request();
    await dispatcher.flush();

    expect(calls.value).toBe(3);
    expect(inputs[2]?.messages.map((message) => message.role)).toEqual(['user']);
    expect(
      inputs[2]?.messages.flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url'),
    ).toHaveLength(2);
    expect(
      records.filter((record) => record.type === 'llm.request').map((record) => record['projection']),
    ).toEqual([undefined, 'media-degraded', 'strict-media-degraded']);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'media-degraded' }),
    ]);
  });
});

describe('AgentLoopRequester request id', () => {
  function createTracedRequester(requestId: string | null): ModelEventRequester {
    const model: Model = {
      id: 'm',
      name: 'wire-model',
      aliases: [],
      protocol: 'openai',
      baseUrl: 'https://example.test',
      headers: {},
      capabilities,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
    };
    return {
      model,
      request: async function* (_input, _signal, requestOptions) {
        requestOptions?.onRequestId?.(requestId ?? undefined);
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          requestId: requestId ?? undefined,
        };
      },
    };
  }

  it('exposes the request id and returns it on finish', async () => {
    const requester = createTracedRequester('trace-req-1');
    const headersArrived = createControlledPromise<void>();
    const releaseStream = createControlledPromise<void>();
    Object.defineProperty(requester, 'request', {
      value: async function* (_input: unknown, _signal: unknown, requestOptions: {
        onRequestId?: (requestId: string | null) => void;
      }) {
        requestOptions.onRequestId?.('trace-req-1');
        headersArrived.resolve();
        await releaseStream;
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          requestId: 'trace-req-1',
        } satisfies ModelRequestEvent;
      },
    });
    const { service } = createService(requester);
    const request = service.start({ source: { type: 'turn', turnId: 1, step: 1 } });
    await headersArrived;
    expect(request.trace.requestId).toBe('trace-req-1');
    releaseStream.resolve();
    const finish = await request.result;

    expect(finish.requestId).toBe('trace-req-1');
    expect(request.trace.requestId).toBe('trace-req-1');
  });

  it('reports an absent trace before a request that returns none', async () => {
    const { service } = createService(createTracedRequester(null));
    const request = service.start();
    const finish = await request.result;

    expect(finish.requestId).toBeUndefined();
    expect(request.trace.requestId).toBeUndefined();
  });

  it('attaches request_id, turn_id and step_no to api_error from the failed request', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(500, 'boom', 'req-1', null, { requestId: 'trace-fail-1' });
      },
    });
    const { service, telemetryRecords } = createService(requester);
    const request = service.start({ source: { type: 'turn', turnId: 3, step: 2 } });
    await expect(request.result).rejects.toMatchObject({ statusCode: 500 });

    expect(telemetryRecords).toContainEqual({
      event: 'api_error',
      properties: expect.objectContaining({
        error_type: '5xx_server',
        request_id: 'trace-fail-1',
        turn_id: 3,
        step_no: 2,
      }),
    });
    expect(request.trace.requestId).toBeUndefined();
  });

  it('uses protocol diagnostics instead of retaining the header request id on failure', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const requestOptions = args[2] as
          | { onRequestId?: (requestId: string | null) => void }
          | undefined;
        requestOptions?.onRequestId?.('trace-mid-stream');
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIEmptyResponseError('no content, no tool calls', {
          diagnostics: { requestId: 'trace-mid-stream' },
        });
      },
    });
    const { service, telemetryRecords } = createService(requester);
    const request = service.start({ source: { type: 'turn', turnId: 4, step: 1 } });
    await expect(request.result).rejects.toThrow();

    const apiError = telemetryRecords.find((record) => record.event === 'api_error');
    expect(apiError?.properties?.['request_id']).toBe('trace-mid-stream');
    expect(request.trace.requestId).toBeUndefined();
  });

  it('clears the previous physical request id before a projection retry', async () => {
    const requester = createTracedRequester(null);
    let attempts = 0;
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        attempts += 1;
        const requestOptions = args[2] as
          | { onRequestId?: (requestId: string | null) => void }
          | undefined;
        if (attempts === 1) {
          requestOptions?.onRequestId?.('trace-first-projection');
          throw new APIRequestTooLargeError(413, 'retry with degraded media');
        }
        throw new APIConnectionError('socket hang up');
      },
    });
    const { service, telemetryRecords } = createService(requester);
    const request = service.start();
    await expect(request.result).rejects.toThrow('socket hang up');

    expect(attempts).toBe(2);
    expect(request.trace.requestId).toBeUndefined();
    expect(
      telemetryRecords.find((record) => record.event === 'api_error')?.properties?.['request_id'],
    ).toBeUndefined();
  });

  it('mirrors the request id into the ambient telemetry context', async () => {
    const { service, telemetry } = createService(
      createTracedRequester('trace-ambient-1'),
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(telemetry.getContext()['request_id']).toBe('trace-ambient-1');
  });

  it('clears the ambient request id when the next turn request starts without one', async () => {
    let nextRequestId: string | undefined = 'trace-ambient-2';
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* (_input: unknown, _signal: unknown, requestOptions: {
        onRequestId?: (requestId: string | undefined) => void;
      }) {
        requestOptions?.onRequestId?.(nextRequestId);
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          requestId: nextRequestId,
        } satisfies ModelRequestEvent;
      },
    });
    const { service, telemetry } = createService(requester);

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(telemetry.getContext()['request_id']).toBe('trace-ambient-2');

    nextRequestId = undefined;
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(telemetry.getContext()['request_id']).toBeUndefined();
  });

  it('clears the ambient request id after a failed request', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(500, 'boom', 'req-1', null, {
          requestId: 'trace-fail-ambient',
        });
      },
    });
    const { service, telemetry } = createService(requester);

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(telemetry.getContext()['request_id']).toBeUndefined();
  });

  it('keeps the ambient request id untouched for operation requests', async () => {
    const { service, telemetry } = createService(
      createTracedRequester('trace-operation-1'),
    );
    telemetry.setContext({ request_id: 'trace-turn-1' });

    await service.request({ source: { type: 'operation', requestKind: 'full_compaction' } });

    expect(telemetry.getContext()['request_id']).toBe('trace-turn-1');
  });
});

describe('AgentLoopRequester media resolver wiring', () => {
  it('runs tool and media resolvers before projection and records the resolved tools', async () => {
    const inputs: ModelRequestInput[] = [];
    const requester = createRequester({ value: 0 }, null, [], inputs);
    const resolvedTool = { name: 'resolved', description: 'resolved tool', parameters: {} };
    let toolSelectCalls = 0;
    const resolve = vi.fn(
      async (
        messages: readonly Message[],
        _resolution: Parameters<IAgentMediaResolverService['resolve']>[1],
      ) => messages,
    );
    const { service, dispatcher, records } = createService(requester, {
      contextMessages: [
        { role: 'assistant', content: [{ type: 'text', text: 'stale' }], toolCalls: [], partial: true },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
      toolSelect: {
        defaultTools: () => [resolvedTool],
        shapeHistory: (messages) => {
          toolSelectCalls += 1;
          expect(messages.map((message) => message.role)).toEqual(['assistant', 'user']);
          return messages;
        },
      },
      mediaResolver: { resolve },
    });

    await service.request();
    await dispatcher.flush();

    expect(toolSelectCalls).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0].map((message) => message.role)).toEqual(['user']);
    expect(resolve.mock.calls[0]?.[1]).toMatchObject(requester.model);
    expect(inputs[0]?.tools).toEqual([resolvedTool]);
    const snapshot = records.find((record) => record.type === 'llm.tools_snapshot');
    const requestRecord = records.find((record) => record.type === 'llm.request');
    expect(snapshot?.['tools']).toEqual([resolvedTool]);
    expect(requestRecord?.['toolsHash']).toBe(snapshot?.['hash']);

    for (const imageIn of [false, true]) {
      const attemptInputs: ModelRequestInput[] = [];
      const base = createRequester({ value: 0 }, null, [], attemptInputs);
      const mediaRequester = {
        ...base,
        model: {
          ...base.model,
          capabilities: { ...base.model.capabilities, image_in: imageIn },
        },
      };
      const mediaTool = { name: 'ReadMediaFile', description: 'read media', parameters: {} };
      const otherTool = { name: 'other', description: 'other', parameters: {} };
      const { service } = createService(mediaRequester, {
        contextMessages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'calling tools' }],
            toolCalls: [
              { type: 'function', id: 'media', name: 'ReadMediaFile', arguments: '{}' },
              { type: 'function', id: 'other', name: 'other', arguments: '{}' },
            ],
          },
          { role: 'tool', toolCallId: 'media', content: [{ type: 'text', text: 'media result' }] },
          { role: 'tool', toolCallId: 'other', content: [{ type: 'text', text: 'other result' }] },
          { role: 'user', content: [{ type: 'text', text: 'continue' }] },
        ],
        toolSelect: { defaultTools: () => [mediaTool, otherTool] },
      });

      await service.request();

      const input = attemptInputs[0]!;
      expect(input.tools).toEqual(imageIn ? [mediaTool, otherTool] : [otherTool]);
      expect(
        input.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls : []).map(
          (call) => call.name,
        ),
      ).toEqual(imageIn ? ['ReadMediaFile', 'other'] : ['other']);
      expect(
        input.messages.flatMap((message) => message.role === 'tool' ? [message.toolCallId] : []),
      ).toEqual(imageIn ? ['media', 'other'] : ['other']);
    }
  });
});

type ScriptedToolCallId = string | { readonly id: string; readonly rawId?: string };

function createScriptedRequester(
  script: { ids: ScriptedToolCallId[]; error?: Error }[],
): ModelEventRequester {
  const base = createRequester({ value: 0 });
  let callIndex = 0;
  return {
    model: base.model,
    request: async function* () {
      const step = script[Math.min(callIndex++, script.length - 1)]!;
      if (step.error !== undefined) {
        if (step.ids.length > 0) {
          const value = step.ids[0]!;
          yield {
            type: 'part',
            part: {
              type: 'function',
              id: typeof value === 'string' ? value : value.id,
              name: 'Bash',
              arguments: null,
              _streamIndex: 0,
              rawId: typeof value === 'string' ? undefined : value.rawId,
            },
          } satisfies ModelRequestEvent;
        }
        throw step.error;
      }
      const toolCalls: ToolCall[] = [];
      for (const [index, value] of step.ids.entries()) {
        const id = typeof value === 'string' ? value : value.id;
        const rawId = typeof value === 'string' ? undefined : value.rawId;
        yield {
          type: 'part',
          part: { type: 'function', id, name: 'Bash', arguments: null, _streamIndex: index, rawId },
        } satisfies ModelRequestEvent;
        yield {
          type: 'part',
          part: { type: 'tool_call_part', argumentsPart: '{"command":"ls"}', index },
        } satisfies ModelRequestEvent;
        toolCalls.push({ type: 'function', id, name: 'Bash', arguments: '{"command":"ls"}', rawId });
      }
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [], toolCalls },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      } satisfies ModelRequestEvent;
    },
  };
}

function createOpenAIModelEventRequester(ids: readonly string[]): ModelEventRequester {
  const base = createRequester({ value: 0 });
  const requester = createOpenAIRequester({
    clientFactory: () => ({
      chat: {
        completions: {
          create: () => ({
            withResponse: async () => ({
              data: (async function* () {
                yield {
                  id: 'chatcmpl-1',
                  object: 'chat.completion.chunk',
                  created: 0,
                  model: 'test-model',
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: ids.map((id, index) => ({
                          index,
                          id,
                          type: 'function',
                          function: { name: 'Bash', arguments: '{"command":"ls"}' },
                        })),
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                };
              })(),
              response: new Response(null),
            }),
          }),
        },
      },
    }) as never,
  });
  const model = { ...base.model, protocol: 'openai' as const };
  const registry = new ProtocolAdapterRegistry();
  return {
    model,
    request: (input, signal, params) =>
      generateModel(coreRequesterFromA(registry.request(model, params), requester), input, signal, params),
  };
}

describe('AgentLoopRequester tool call id forwarding', () => {
  it('passes lower-layer unique ids through unchanged', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(
      createScriptedRequester([{ ids: ['call_1', 'call_2'] }]),
    );

    const result = await service.request({}, (part) => {
      parts.push(part);
    });

    expect(result.message.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect(parts.filter(isToolCall).map((p) => p.id)).toEqual(['call_1', 'call_2']);
  });

  it('normalizes repeated provider ids in llm and forwards the result', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(createOpenAIModelEventRequester(['Bash_0']));

    const first = await service.request({}, (part) => {
      parts.push(part);
    });
    const second = await service.request(
      {
        messages: [
          ...history,
          first.message,
          { role: 'tool', content: [{ type: 'text', text: 'done' }], toolCallId: 'Bash_0' },
        ],
      },
      (part) => {
        parts.push(part);
      },
    );

    expect(first.message.toolCalls[0]!.id).toBe('Bash_0');
    expect(second.message.toolCalls[0]).toMatchObject({ id: 'Bash_0__2', rawId: 'Bash_0' });
    expect(parts.filter(isToolCall).map((p) => [p.id, p.rawId])).toEqual([
      ['Bash_0', undefined],
      ['Bash_0__2', 'Bash_0'],
    ]);
  });

  it('preserves lower-layer duplicate id assignments', async () => {
    const { service } = createService(
      createScriptedRequester([
        { ids: ['Bash_0', { id: 'Bash_0__2', rawId: 'Bash_0' }] },
      ]),
    );

    const result = await service.request();

    expect(result.message.toolCalls.map((c) => [c.id, c.rawId])).toEqual([
      ['Bash_0', undefined],
      ['Bash_0__2', 'Bash_0'],
    ]);
  });

  it('does not alter lower-layer ids after a failed attempt', async () => {
    const { service } = createService(
      createScriptedRequester([
        { ids: ['Bash_9'], error: new Error('stream boom') },
        { ids: ['Bash_9'] },
      ]),
    );

    await expect(service.request()).rejects.toThrow('stream boom');
    const retry = await service.request();
    expect(retry.message.toolCalls[0]!.id).toBe('Bash_9');
  });

  it('does not rewrite ids against restored context', async () => {
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0'] }]),
      {
        contextMessages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ type: 'function', id: 'Bash_0', name: 'Bash', arguments: '{}' }],
          },
        ],
      },
    );

    const result = await service.request();
    expect(result.message.toolCalls[0]!.id).toBe('Bash_0');
  });
});

describe('AgentLoopRequester attempt retry notification', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies before resending with a repaired projection', async () => {
    const calls = { value: 0 };
    const { service } = createService(createRequester(calls));
    const onAttemptRetry = vi.fn();

    const result = await service.request({ onAttemptRetry });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(onAttemptRetry).toHaveBeenCalledTimes(1);
  });

  it('notifies before each indefinite-retry backoff', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIConnectionError('socket hang up'), [
      new APIConnectionError('socket hang up again'),
    ]);
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });
    const onAttemptRetry = vi.fn();

    const promise = service.request({ onAttemptRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls.value).toBe(3);
    expect(onAttemptRetry).toHaveBeenCalledTimes(2);
  });

  it('does not notify when the error is final', async () => {
    const calls = { value: 0 };
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'max_tokens must be positive')),
    );
    const onAttemptRetry = vi.fn();

    await expect(service.request({ onAttemptRetry })).rejects.toMatchObject({ statusCode: 400 });
    expect(onAttemptRetry).not.toHaveBeenCalled();
  });
});

describe('turn machine stream state across service-internal retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('discards the interrupted attempt stream when the service retries below the turn', async () => {
    vi.useFakeTimers();
    const { service } = createService(
      createScriptedRequester([
        { ids: ['call_a'], error: new APIConnectionError('terminated') },
        { ids: ['call_b'] },
      ]),
      { env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' } },
    );
    const machineRequester = createMachineRequester(service);
    const doneEntries: AssistantEntry[] = [];
    const actor = createActor(createTurnHarness(machineRequester.requester), {
      input: { request: { model: turnHarnessModel }, history: [] },
    });
    actor.on('llm.done', (event) => doneEntries.push(event.entry));
    actor.start();

    await vi.runAllTimersAsync();
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(doneEntries).toHaveLength(1);
    expect(doneEntries[0]?.message.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_b']);
  });
});
