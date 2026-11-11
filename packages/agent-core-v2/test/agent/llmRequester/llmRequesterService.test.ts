import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { AgentLoopRequestFactory, KIMI_CODE_INFINITE_RETRY_ENV } from '#/agent/loop/requester';
import { AgentLoopRequestObserver } from '#/agent/loop/requestObservation';
import {
  agentRoleOf,
  requestMetadataHeaders,
  turnTriggerOf,
  userInputIdOf,
} from '#/agent/loop/requestMetadata';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { ISessionRequestAttributionService } from '#/session/requestAttribution/requestAttribution';
import { SessionRequestAttributionService } from '#/session/requestAttribution/requestAttributionService';
import { LOOP_CONTROL_SECTION } from '#/agent/loop/configSection';
import { createAgentMediaPolicy } from '#/agent/loop/mediaPolicy';
import { createMediaRecoveryStore, type LoopRequestRuntime } from '#/agent/loop/core/index';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
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
  type ToolDescription as Tool,
} from '#human/llm/message';
import { mediaUrlOf } from '#human/llm/protocol/kit/media';
import type { LlmRequest as CoreLlmRequest } from '#human/llm/request';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import {
  errorFromLlmOutcome,
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
  restoreTestEventDispatcher,
} from '../../wire/stubs';

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
  calls: { value: number } = { value: 0 },
  firstCallError?: Error | null,
  subsequentCallErrors: readonly Error[] = [],
  capturedInputs?: ModelRequestInput[],
  modelPatch: Partial<Model> = {},
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
    ...modelPatch,
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
              new APIStatusError(400, 'messages: `tool_use` ids must be unique', false))
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
const serviceRuntimes = new WeakMap<AgentLoopRequestFactory, LoopRequestRuntime>();

function runtimeOf(service: AgentLoopRequestFactory): LoopRequestRuntime {
  const runtime = serviceRuntimes.get(service);
  if (runtime === undefined) throw new Error('missing request runtime');
  return runtime;
}

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
    readonly systemPrompt?: () => string;
    readonly requestParams?: () => ReturnType<IAgentLoopService['resolveRequestParams']>;
    readonly maxAttemptsPerStep?: number;
    readonly metadata?: AgentMeta;
    readonly parentUserInputId?: string;
    readonly parentRequestId?: string;
  } = {},
) {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-code-llm-requester-test', options.env ?? {}));
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const profile: Partial<IAgentLoopService> = {
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
    resolveRequestParams: () => options.requestParams?.() ?? {},
    getSystemPrompt: () => options.systemPrompt?.() ?? 'system',
    data: () => ({
      cwd: '',
      modelAlias: 'm',
      modelCapabilities: capabilities,
      thinkingLevel,
      systemPrompt: options.systemPrompt?.() ?? 'system',
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
  const usageAliases: string[] = [];
  const usage = {
    record: (_agent: AgentContext, alias: string) => {
      usageAliases.push(alias);
      return Promise.resolve();
    },
    status: () => ({}),
  };
  const context = {
    get: () => options.contextMessages ?? history,
    prefixRevision: options.prefixRevision ?? (() => 0),
  };
  const config: Partial<IConfigService> = {
    get: ((section: string) =>
      section === LOOP_CONTROL_SECTION
        ? { maxAttemptsPerStep: options.maxAttemptsPerStep }
        : undefined) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetryRecords: TelemetryRecord[] = [];
  const telemetry = recordingTelemetry(telemetryRecords);
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    prepareForRequest: async () => {},
    defaultTools: () => [],
    requestTools: (base, disclosure) => base ?? toolSelect.defaultTools!(disclosure),
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
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentMediaResolverService, mediaResolver);
  ix.stub(ISessionTokenCountingService, tokenCounting);
  ix.stub(IAgentLoopService, profile);
  ix.stub(ISessionUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.stub(IModelCatalog, {
    _serviceBrand: undefined,
    get: () => requester.model,
    findByName: () => [],
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
  if (options.metadata !== undefined) {
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId: 'test-agent',
        agentScope: 'wire/llm-requester',
        meta: options.metadata,
        generation: 0,
      }),
    );
  }
  const attribution = new SessionRequestAttributionService();
  if (options.parentUserInputId !== undefined) {
    attribution.noteUserInput('main', options.parentUserInputId);
  }
  if (options.parentRequestId !== undefined) {
    attribution.noteActiveRequest('main', options.parentRequestId);
  }
  ix.set(ISessionRequestAttributionService, attribution);
  registerTestEventDispatcher(ix);
  ix.set(IAgentStateService, new AgentStateService());
  const observer = ix.createInstance(AgentLoopRequestObserver);
  const service = ix.createInstance(
    new SyncDescriptor(AgentLoopRequestFactory, [observer, () => profile as IAgentLoopService]),
  ) as AgentLoopRequestFactory;
  service.bindHistory(() => context.get());
  service.registerMediaPolicy((model, request) =>
    createAgentMediaPolicy(mediaResolver, model, request),
  );
  const runtime: LoopRequestRuntime = {
    historyRevision: context.prefixRevision,
    mediaRecovery: createMediaRecoveryStore(),
  };
  serviceRuntimes.set(service, runtime);

  return {
    service,
    runtime,
    dispatcher: ix.get(IEventDispatcher),
    records,
    events,
    telemetry,
    telemetryRecords,
    measuredCalls,
    usageAliases,
    attribution,
  };
}

type RequestSource = ReturnType<Parameters<AgentLoopRequestFactory['coreRequester']>[0]['source']>;

interface RequestOverrides {
  readonly messages?: readonly Message[];
  readonly tools?: readonly Tool[];
  readonly systemPrompt?: string;
  readonly source?: RequestSource;
  readonly maxOutputSize?: number;
  readonly usedContextTokens?: number;
  readonly promptCacheProbe?: 'compaction';
  readonly onAttemptRetry?: () => void;
}

async function request(
  service: AgentLoopRequestFactory,
  overrides: RequestOverrides = {},
  onPart: (part: StreamedMessagePart) => void | Promise<void> = () => {},
  signal = new AbortController().signal,
  onTrace?: (trace: { readonly requestId: string | undefined }) => void,
) {
  const source: RequestSource = overrides.source ?? { type: 'operation' };
  const pendingParts: Promise<void>[] = [];
  const outcome = await service.coreRequester({
    source: () => source,
    runtime: runtimeOf(service),
    maxOutputSize: overrides.maxOutputSize,
    promptCacheProbe: overrides.promptCacheProbe,
    tools: overrides.tools,
    onTrace,
  }).with({ policy: { retry: { maxAttemptsPerStep: 1 } } }).generate(
    {
      content: { messages: overrides.messages, usedTokens: overrides.usedContextTokens },
      profile: { systemPrompt: overrides.systemPrompt, tools: overrides.tools },
    },
    {
      signal,
      onEvent: (event) => {
        if (event.type === 'llm.streaming.part') {
          const pending = onPart(event.part);
          if (pending instanceof Promise) pendingParts.push(pending);
        } else if (event.type === 'llm.retrying') {
          overrides.onAttemptRetry?.();
        }
      },
    },
  );
  await Promise.all(pendingParts);
  if (outcome.type !== 'done') throw errorFromLlmOutcome(outcome);
  return {
    message: outcome.message,
    usage: outcome.usage ?? emptyUsage(),
    model: undefined,
    providerFinishReason: outcome.finish?.finishReason ?? undefined,
    rawFinishReason: outcome.finish?.rawFinishReason ?? undefined,
    providerMessageId: outcome.messageId,
    timing: outcome.timing,
    requestId: outcome.requestId,
  };
}

function startRequest(service: AgentLoopRequestFactory, overrides: RequestOverrides = {}) {
  let trace: { readonly requestId: string | undefined } = { requestId: undefined };
  return {
    get trace() {
      return trace;
    },
    result: request(service, overrides, undefined, undefined, (current) => {
      trace = current;
    }),
  };
}

function metadataHeader(
  service: AgentLoopRequestFactory,
  source: RequestSource = { type: 'operation' },
): string | undefined {
  return service.coreRequester({
    source: () => source,
    runtime: runtimeOf(service),
  }).request({ content: { messages: [] } }).endpoint?.headers?.['X-Msh-Client-Metadata'];
}

async function startMetadataTurn(
  dispatcher: IEventDispatcher,
  origin: PromptOrigin = { kind: 'user' },
  promptId?: string,
  turnId = 1,
): Promise<void> {
  await dispatcher.dispatch(new TurnPrompt({
    agentId: 'test-agent',
    turnId,
    origin,
    promptId,
    input: [],
  }));
}

describe('AgentLoopRequestFactory measured anchors', () => {
  it('skips the measured anchor when the stream reports no usage', async () => {
    const { service, measuredCalls } = createService(createRequester({ value: 0 }));

    await request(service);

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

    await request(service);

    expect(measuredCalls).toHaveLength(1);
    expect(measuredCalls[0]?.usage.inputOther).toBe(40);
  });
});

function cacheUsage(inputCacheRead: number): TokenUsage {
  return { inputOther: 100, output: 50, inputCacheRead, inputCacheCreation: 0 };
}

function createCacheRequester(
  usages: readonly (TokenUsage | 'unreported' | undefined)[],
): ModelEventRequester {
  const requester = createRequester({ value: 0 }, null);
  const base = requester.request.bind(requester);
  let index = 0;
  requester.request = async function* (input, signal, options) {
    const current = index++;
    const usage = usages[current];
    if (usage === 'unreported') {
      yield {
        type: 'usage',
        usage: { ...cacheUsage(0), inputCacheRead: undefined },
        model: 'wire-model',
      };
    } else if (usage !== undefined) {
      yield { type: 'usage', usage, model: 'wire-model' };
    }
    for await (const event of base(input, signal, options)) {
      yield event.type === 'finish' ? { ...event, requestId: `trace-${current + 1}` } : event;
    }
  };
  return { ...requester, model: { ...requester.model, protocol: 'openai' } };
}

function cacheBreaks(records: readonly TelemetryRecord[]): TelemetryRecord[] {
  return records.filter((record) => record.event === 'cache_break_detected');
}

function projectionFallbacks(records: readonly TelemetryRecord[]): unknown[] {
  return records
    .filter((record) => record.event === 'llm_request_projection_fallback')
    .map((record) => record.properties?.['projection']);
}

async function requestCacheTurn(
  service: AgentLoopRequestFactory,
  turnId: number,
  systemPrompt?: string,
): Promise<void> {
  await request(service, { source: { type: 'turn', turnId, step: turnId }, systemPrompt });
}

async function requestCacheOperation(service: AgentLoopRequestFactory, requestKind: string): Promise<void> {
  await request(service, { source: { type: 'operation', requestKind } });
}

describe('AgentLoopRequestFactory cache break telemetry', () => {
  it('reports request identifiers, both usages and changed request parts', async () => {
    const { service, telemetryRecords } = createService(
      createCacheRequester([cacheUsage(10000), cacheUsage(7000)]),
    );

    await requestCacheTurn(service, 1);
    expect(cacheBreaks(telemetryRecords)).toHaveLength(0);
    await requestCacheTurn(service, 2);

    const events = cacheBreaks(telemetryRecords);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({
      request_kind: 'turn',
      turn_id: 2,
      step_no: 2,
      trace_id: 'trace-2',
      prev_request_kind: 'turn',
      prev_turn_id: 1,
      prev_step_no: 1,
      prev_trace_id: 'trace-1',
      prev_model: 'm',
      curr_model: 'm',
      prev_effort: 'off',
      curr_effort: 'off',
      prev_input_cache_read: 10000,
      curr_input_cache_read: 7000,
      prev_input_other: 100,
      curr_input_other: 100,
      prev_output: 50,
      curr_output: 50,
      prev_input_cache_creation: 0,
      curr_input_cache_creation: 0,
      prev_total_tokens: 10150,
      cache_reuse_ratio: 7000 / 10150,
      cache_read_drop_ratio: 0.3,
      tools_match: true,
      system_prompt_match: true,
      history_prefix_match: true,
    });
    expect(events[0]?.properties?.['gap_ms']).toEqual(expect.any(Number));
    expect(events[0]?.properties?.['interval_ms']).toEqual(expect.any(Number));

    const contextMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
    ];
    const changed = createService(
      createCacheRequester([cacheUsage(10000), cacheUsage(1000)]),
      { contextMessages },
    );
    await requestCacheTurn(changed.service, 1, 'system-a');
    contextMessages[0] = { role: 'user', content: [{ type: 'text', text: 'rewritten' }] };
    await requestCacheTurn(changed.service, 2, 'system-b');

    expect(cacheBreaks(changed.telemetryRecords)[0]?.properties).toMatchObject({
      tools_match: true,
      system_prompt_match: false,
      history_prefix_match: false,
    });

    const operation = createService(
      createCacheRequester([cacheUsage(10000), cacheUsage(7000), cacheUsage(1000)]),
    );
    await requestCacheTurn(operation.service, 1);
    await requestCacheOperation(operation.service, 'full_compaction');
    await requestCacheTurn(operation.service, 2);

    const operationEvents = cacheBreaks(operation.telemetryRecords);
    expect(operationEvents).toHaveLength(2);
    expect(operationEvents[0]?.properties).toMatchObject({
      request_kind: 'full_compaction',
      prev_request_kind: 'turn',
      trace_id: 'trace-2',
    });
    expect(operationEvents[0]?.properties?.['turn_id']).toBeUndefined();
    expect(operationEvents[1]?.properties).toMatchObject({
      request_kind: 'turn',
      prev_request_kind: 'full_compaction',
      turn_id: 2,
      trace_id: 'trace-3',
      prev_trace_id: 'trace-2',
    });
    expect(operationEvents[1]?.properties?.['prev_turn_id']).toBeUndefined();
  });

  it('applies ratio and token gates to cache reads and reusable history', async () => {
    const a = createService(createCacheRequester([cacheUsage(100000), cacheUsage(96000)]));
    await requestCacheTurn(a.service, 1);
    await requestCacheTurn(a.service, 2);
    expect(cacheBreaks(a.telemetryRecords)).toHaveLength(0);

    const b = createService(createCacheRequester([cacheUsage(4000), cacheUsage(2500)]));
    await requestCacheTurn(b.service, 1);
    await requestCacheTurn(b.service, 2);
    expect(cacheBreaks(b.telemetryRecords)).toHaveLength(0);

    const coverage = createService(
      createCacheRequester([
        { ...cacheUsage(10000), inputOther: 5000, output: 2000 },
        cacheUsage(9600),
      ]),
    );
    await requestCacheTurn(coverage.service, 1);
    await requestCacheTurn(coverage.service, 2);
    expect(cacheBreaks(coverage.telemetryRecords)).toHaveLength(1);
    expect(cacheBreaks(coverage.telemetryRecords)[0]?.properties).toMatchObject({
      prev_total_tokens: 17000,
      cache_reuse_ratio: 9600 / 17000,
      cache_read_drop_ratio: 0.04,
    });
  });

  it('skips unmeasured usage and distinguishes unreported cache reads from explicit zeroes', async () => {
    const { service, telemetryRecords } = createService(
      createCacheRequester([cacheUsage(10000), undefined, emptyUsage(), 'unreported', cacheUsage(5000)]),
    );

    for (let turnId = 1; turnId <= 5; turnId++) await requestCacheTurn(service, turnId);

    const events = cacheBreaks(telemetryRecords);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({
      prev_turn_id: 1,
      prev_input_cache_read: 10000,
      turn_id: 5,
      curr_input_cache_read: 5000,
    });

    const never = createService(createCacheRequester(['unreported', 'unreported']));
    await requestCacheTurn(never.service, 1);
    await requestCacheTurn(never.service, 2);
    expect(cacheBreaks(never.telemetryRecords)).toHaveLength(0);

    const zero = createService(
      createCacheRequester([
        { ...cacheUsage(0), inputOther: 5000, output: 1000 },
        cacheUsage(1000),
      ]),
    );
    await requestCacheTurn(zero.service, 1);
    await requestCacheTurn(zero.service, 2);
    const zeroEvent = cacheBreaks(zero.telemetryRecords)[0]?.properties;
    expect(zeroEvent).toMatchObject({
      prev_input_cache_read: 0,
      prev_total_tokens: 6000,
      cache_reuse_ratio: 1000 / 6000,
    });
    expect(zeroEvent?.['cache_read_drop_ratio']).toBeUndefined();
  });

  it('resets after a context revision change and records model changes', async () => {
    let revision = 0;
    const reset = createService(
      createCacheRequester([cacheUsage(10000), cacheUsage(5000), cacheUsage(1000)]),
      { prefixRevision: () => revision },
    );
    await requestCacheTurn(reset.service, 1);
    revision = 1;
    await requestCacheTurn(reset.service, 2);
    expect(cacheBreaks(reset.telemetryRecords)).toHaveLength(0);
    await requestCacheTurn(reset.service, 3);

    expect(cacheBreaks(reset.telemetryRecords)[0]?.properties).toMatchObject({
      prev_turn_id: 2,
      prev_input_cache_read: 5000,
      turn_id: 3,
      curr_input_cache_read: 1000,
    });

    let model = 'm';
    const changed = createService(
      createCacheRequester([cacheUsage(10000), cacheUsage(100)]),
      { modelAlias: () => model },
    );
    await requestCacheTurn(changed.service, 1);
    model = 'other-model';
    await requestCacheTurn(changed.service, 2);

    expect(cacheBreaks(changed.telemetryRecords)[0]?.properties).toMatchObject({
      prev_model: 'm',
      curr_model: 'other-model',
    });
  });
});

describe('AgentLoopRequestFactory Anthropic effort diagnostics', () => {
  it('warns and sends when the effort is not listed by the model', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null);
    Object.defineProperty(requester.model, 'supportEfforts', { value: ['max'] });
    const { service, events } = createService(requester, { thinkingLevel: 'high' });

    const result = await request(service);

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

describe('AgentLoopRequestFactory strict resend', () => {
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

    const result = await request(service);

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
      createRequester(calls, new APIStatusError(401, 'unauthorized', false)),
    );

    await expect(request(service)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(calls.value).toBe(1);
  });
});

describe('AgentLoopRequestFactory infinite retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries every request error while KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken', false), [
      new APIStatusError(404, 'model not found', false),
      new APIConnectionError('socket hang up'),
      new APIProviderQuotaExhaustedError('quota exhausted'),
    ]);
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    const promise = request(service);
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
    await request(service);

    expect(calls.value).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('stops retrying when the caller aborts during the backoff wait', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken', false));
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 100);

    const promise = request(service, {}, undefined, controller.signal);
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

    await request(service);

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

    await expect(request(service)).rejects.toBeInstanceOf(APIContextOverflowError);
    expect(calls.value).toBe(1);
  });

  it('retries operation requests indefinitely', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken', false), [
      new APIStatusError(404, 'model not found', false),
    ]);
    const { service } = createService(requester, {
      env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
    });

    const promise = request(service, {
      source: { type: 'operation', requestKind: 'full_compaction' },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls.value).toBe(3);
  });

  it('does not retry when the switch is unset', async () => {
    vi.useFakeTimers();
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIStatusError(400, 'endpoint broken', false));
    const { service } = createService(requester);

    await expect(request(service)).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
  });
});

describe('AgentLoopRequestFactory media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
    false,
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

      const result = await request(service);

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

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);

    await request(service, { source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([1, 0, 0]);
  });

  it('does not resend for an unrelated 400', async () => {
    const calls = { value: 0 };
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'some other validation problem', false)),
    );

    await expect(request(service)).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
  });

  it('warns the user when media are stripped from the retried request', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, events } = createService(
      createRequester(calls, IMAGE_FORMAT_400),
      { contextMessages },
    );

    await request(service);
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

describe('AgentLoopRequestFactory media-degraded resend', () => {
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

    const result = await request(service);

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

    await request(service, { messages, source: { type: 'turn', turnId: 1, step: 1 } });

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
    await request(service, { messages, source: { type: 'turn', turnId: 1, step: 2 } });

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

    const result = await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([3, 2, 0]);
  });

  it('records repeated-413 recovery projections on the sticky later request', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service, dispatcher, telemetryRecords } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413], inputs),
      { contextMessages: threeImages() },
    );

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });
    await request(service, { source: { type: 'turn', turnId: 1, step: 2 } });
    await dispatcher.flush();

    expect(projectionFallbacks(telemetryRecords)).toEqual(['media-degraded', 'media-stripped']);
    expect(mediaCounts(inputs)).toEqual([3, 2, 0, 0]);
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

    await request(service, {
      messages: [imageMessage(oldUrl, 'rejected-id')],
      source: { type: 'turn', turnId: 1, step: 1 },
    });
    await request(service, {
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
      request(service, { source: { type: 'turn', turnId: 1, step: 1 } }),
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

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);

    await request(service, { source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(mediaCounts(inputs)).toEqual([3, 2, 2]);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive', false),
      new APIStatusError(422, 'unprocessable', false),
    ]) {
      const calls = { value: 0 };
      const { service } = createService(createRequester(calls, error));

      await expect(request(service)).rejects.toStrictEqual(error);
      expect(calls.value).toBe(1);
    }
  });

  it('does not warn when the degraded projection leaves the request unchanged', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, events } = createService(
      createRequester(calls, BODY_TOO_LARGE_413),
    );

    await request(service);
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

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });
    await dispatcher.flush();

    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'media-degraded' }),
      expect.objectContaining({ type: 'warning', code: 'media-stripped' }),
    ]);
  });
});

describe('AgentLoopRequestFactory media recovery prefix parity', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
    false,
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

    await request(service, { messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    expect(inputs).toHaveLength(2);
    const settled = inputs[1]!;

    await request(service, {
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

    await request(service, { messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    expect(inputs).toHaveLength(2);
    const settled = inputs[1]!;

    await request(service, {
      messages: [...degradedTurn, imageMessage('data:image/png;base64,FRESH', 'fresh')],
      source: { type: 'turn', turnId: 2, step: 1 },
    });

    expect(inputs).toHaveLength(3);
    expectPrefixExtension(settled, inputs[2]!);
  });

  it('re-degrades instead of stripping when new media push an inherited degraded request over the limit', async () => {
    const inputs: ModelRequestInput[] = [];
    const { service } = createService(mediaRejectingRequester(inputs));

    await request(service, { messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    await request(service, {
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

      await request(service, { messages: [rejected], source: { type: 'turn', turnId: 1, step: 1 } });
      expect(inputs).toHaveLength(2);

      await request(service, { messages: [rejected, ...added], source });

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

      await request(service, {
        messages: [rejected, ...added, textMessage('next turn')],
        source: { type: 'turn', turnId: 3, step: 1 },
      });

      expect(inputs).toHaveLength(5);
      expect(
        inputs[4]!.messages.flatMap((message) => message.content)
          .filter((part) => part.type === 'image_url'),
      ).toEqual([]);
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
      await request(service, { messages: [rejected], source: { type: 'turn', turnId: 1, step: 1 } });

      requester.request = createRequester({ value: 0 }, error, [error], inputs).request;
      const messages = hasNewMedia
        ? [rejected, imageMessage('data:image/png;base64,FRESH', 'fresh')]
        : [rejected];
      await expect(
        request(service, { messages, source: { type: 'turn', turnId: 2, step: 1 } }),
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

    await request(service, { messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
    expect(inputs).toHaveLength(2);

    if (bump === 'revision') revision += 1;
    else modelAlias = 'other';
    await request(service, { messages: degradedTurn, source: { type: 'turn', turnId: 2, step: 1 } });

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

      await request(service, { messages: degradedTurn, source: { type: 'turn', turnId: 1, step: 1 } });
      expect(inputs).toHaveLength(2);
      const settled = inputs[1]!;

      await request(service, {
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

      await request(service, { messages: [rejected], source: { type: 'turn', turnId: 1, step: 1 } });
      await request(service, {
        messages: [rejected, fresh],
        source: { type: 'turn', turnId: 1, step: 2 },
      });
      expect(inputs).toHaveLength(3);
      const lastLoop = inputs[2]!;
      expect(
        lastLoop.messages.flatMap((message) => message.content).filter((part) => part.type === 'image_url'),
      ).toEqual(fresh.content);

      await request(service, {
        messages: [rejected, fresh, textMessage(COMPACTION_INSTRUCTION)],
        source: { type: 'operation', turnId, requestKind: 'full_compaction' },
      });

      expectPrefixExtension(lastLoop, inputs[3]!);
      expect(inputs).toHaveLength(4);
    },
  );
});

describe('AgentLoopRequestFactory combined recovery projections', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
    false,
  );
  const STRUCTURAL_400 = new APIStatusError(400, 'messages: `tool_use` ids must be unique', false);

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
    const { service, dispatcher, telemetryRecords } = createService(
      createRequester(calls, STRUCTURAL_400, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413], inputs),
      { contextMessages },
    );

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });

    expect(calls.value).toBe(4);
    expect(inputs.map((input) => input.messages.map((message) => message.role))).toEqual([
      ['assistant', 'user'],
      ['user'],
      ['user'],
      ['user'],
    ]);
    await dispatcher.flush();
    expect(projectionFallbacks(telemetryRecords)).toEqual([
      'strict',
      'media-degraded',
      'media-stripped',
    ]);

    await request(service, { source: { type: 'turn', turnId: 1, step: 2 } });
    await dispatcher.flush();

    expect(calls.value).toBe(5);
    expect(inputs[4]?.messages.map((message) => message.role)).toEqual(['assistant', 'user']);
    expect(projectionFallbacks(telemetryRecords).at(-1)).toBe('media-stripped');
  });

  it('strips rejected images on top of strict after an image-format rejection on the strict resend', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service, dispatcher, telemetryRecords } = createService(
      createRequester(calls, STRUCTURAL_400, [IMAGE_FORMAT_400], inputs),
      { contextMessages },
    );

    await request(service);

    expect(calls.value).toBe(3);
    expect(
      inputs[2]?.messages.flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url'),
    ).toEqual([]);
    await dispatcher.flush();
    expect(projectionFallbacks(telemetryRecords)).toEqual(['strict', 'media-stripped']);
  });

  it('applies the strict repair on top of degraded media without repeating the media warning', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const { service, dispatcher, events, telemetryRecords } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [STRUCTURAL_400], inputs),
      { contextMessages },
    );

    await request(service);
    await dispatcher.flush();

    expect(calls.value).toBe(3);
    expect(inputs[2]?.messages.map((message) => message.role)).toEqual(['user']);
    expect(
      inputs[2]?.messages.flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url'),
    ).toHaveLength(2);
    expect(projectionFallbacks(telemetryRecords)).toEqual(['media-degraded', 'strict']);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'media-degraded' }),
    ]);
  });
});

describe('AgentLoopRequestFactory request id', () => {
  function createTracedRequester(requestId: string | null, modelPatch: Partial<Model> = {}): ModelEventRequester {
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
      ...modelPatch,
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

  it('exposes request ids and attaches declared metadata through the same request pipeline', async () => {
    const requester = createTracedRequester('trace-req-1', { providerType: 'kimi' });
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
    const metadata: AgentMeta = {
      type: 'sub',
      labels: { parentAgentId: 'main', profileName: 'coder' },
    };
    const { service, dispatcher, attribution } = createService(requester, { metadata });
    const other = createService(createRequester({ value: 0 }), { metadata });
    await startMetadataTurn(dispatcher, { kind: 'user' }, '任务-1🚀');
    const source: RequestSource = { type: 'turn', turnId: 1, step: 1 };
    const header = metadataHeader(service, source);

    expect(header).toBeDefined();
    expect(new Headers({ 'X-Msh-Client-Metadata': header! }).get('X-Msh-Client-Metadata')).toBe(header);
    expect(JSON.parse(header!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'user',
      step_reason: 'turn_start',
      user_input_id: '任务-1🚀',
    });
    expect(metadataHeader(other.service, source)).toBeUndefined();
    expect([
      agentRoleOf('main', undefined),
      agentRoleOf('child', { labels: { btw: 'true' } }),
      agentRoleOf('child', { labels: { profileName: 'tower-worker' } }),
      agentRoleOf('child', { labels: { swarmItem: '1' } }),
      agentRoleOf('child', { type: 'sub' }),
      agentRoleOf('child', undefined),
    ]).toEqual(['main', 'btw', 'tower_worker', 'swarm_member', 'subagent', 'other']);
    expect([
      turnTriggerOf({ kind: 'user' }),
      turnTriggerOf({ kind: 'skill_activation', activationId: 'a', skillName: 's', trigger: 'user-slash' }),
      turnTriggerOf({ kind: 'plugin_command', activationId: 'a', pluginId: 'p', commandName: 'c', trigger: 'user-slash' }),
      turnTriggerOf({ kind: 'system_trigger', name: 'subagent' }),
      turnTriggerOf({ kind: 'system_trigger', name: 'goal_continuation' }),
      turnTriggerOf({ kind: 'retry' }),
      turnTriggerOf({ kind: 'cron_job', jobId: 'j', cron: '* * * * *', recurring: true, coalescedCount: 1, stale: false }),
      turnTriggerOf({ kind: 'cron_missed', count: 1 }),
      turnTriggerOf({ kind: 'task', taskId: 't', status: 'completed', notificationId: 'n' }),
      turnTriggerOf({ kind: 'injection', variant: 'tower_inbox' }),
      turnTriggerOf({ kind: 'injection', variant: 'shell_command_backgrounded' }),
      turnTriggerOf({ kind: 'hook_result', event: 'Stop' }),
    ]).toEqual([
      'user',
      'skill',
      'plugin_command',
      'subagent_task',
      'goal_continuation',
      'swarm_retry',
      'cron',
      'cron',
      'background_task',
      'tower_inbox',
      'shell_background',
      'other',
    ]);
    expect(userInputIdOf({ kind: 'skill_activation', activationId: 'a', skillName: 's', trigger: 'model-tool' }, 'msg_1')).toBeUndefined();
    expect(userInputIdOf({ kind: 'plugin_command', activationId: 'a', pluginId: 'p', commandName: 'c', trigger: 'user-slash' }, 'msg_2')).toBe('msg_2');
    expect(requestMetadataHeaders({ agentRole: 'main' })).toEqual({
      'X-Msh-Client-Metadata': '{"agent_role":"main"}',
    });

    const request = startRequest(service, { source });
    await headersArrived;
    expect(request.trace.requestId).toBe('trace-req-1');
    releaseStream.resolve();
    const finish = await request.result;

    expect(finish.requestId).toBe('trace-req-1');
    expect(request.trace.requestId).toBe('trace-req-1');
    expect(attribution.of('test-agent')).toEqual({
      userInputId: '任务-1🚀',
      activeRequestId: 'trace-req-1',
    });
    await dispatcher.dispatch(new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }));
    expect(attribution.of('test-agent')).toEqual({ userInputId: '任务-1🚀' });
  });

  it('reports an absent trace before a request that returns none', async () => {
    const { service } = createService(createTracedRequester(null));
    const request = startRequest(service);
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
        throw new APIStatusError(500, 'boom', true, 'req-1', null, { requestId: 'trace-fail-1' });
      },
    });
    const { service, telemetryRecords } = createService(requester);
    const request = startRequest(service, { source: { type: 'turn', turnId: 3, step: 2 } });
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
    const request = startRequest(service, { source: { type: 'turn', turnId: 4, step: 1 } });
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
    const request = startRequest(service);
    await expect(request.result).rejects.toThrow('socket hang up');

    expect(attempts).toBe(2);
    expect(request.trace.requestId).toBeUndefined();
    expect(
      telemetryRecords.find((record) => record.event === 'api_error')?.properties?.['request_id'],
    ).toBeUndefined();
  });

  it('mirrors request ids and keeps subagent attribution at dispatch boundaries', async () => {
    const metadata: AgentMeta = {
      type: 'sub',
      labels: { parentAgentId: 'main', profileName: 'coder' },
    };
    const { service, telemetry, dispatcher, attribution } = createService(
      createTracedRequester('trace-ambient-1', { providerType: 'kimi' }),
      {
        metadata,
        parentUserInputId: 'msg_parent_1',
        parentRequestId: 'trace-parent-1',
      },
    );

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });
    expect(telemetry.getContext()['request_id']).toBe('trace-ambient-1');
    await startMetadataTurn(dispatcher, { kind: 'system_trigger', name: 'subagent' }, 'sub_1');
    expect(JSON.parse(metadataHeader(service, { type: 'turn', turnId: 1, step: 1 })!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'subagent_task',
      step_reason: 'turn_start',
      user_input_id: 'msg_parent_1',
      parent_request_id: 'trace-parent-1',
    });

    attribution.noteUserInput('main', 'msg_parent_2');
    attribution.noteActiveRequest('main', 'trace-parent-2');
    await startMetadataTurn(dispatcher, { kind: 'retry' }, undefined, 2);
    expect(JSON.parse(metadataHeader(service, { type: 'turn', turnId: 2, step: 1 })!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'swarm_retry',
      step_reason: 'turn_start',
      user_input_id: 'msg_parent_1',
      parent_request_id: 'trace-parent-1',
    });
    await startMetadataTurn(dispatcher, { kind: 'injection', variant: 'tower_inbox' }, undefined, 3);
    expect(JSON.parse(metadataHeader(service, { type: 'turn', turnId: 3, step: 1 })!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'tower_inbox',
      step_reason: 'turn_start',
      user_input_id: 'msg_parent_1',
      parent_request_id: 'trace-parent-1',
    });
    await startMetadataTurn(dispatcher, { kind: 'system_trigger', name: 'subagent' }, 'sub_2', 4);
    expect(JSON.parse(metadataHeader(service, { type: 'turn', turnId: 4, step: 1 })!)).toMatchObject({
      user_input_id: 'msg_parent_2',
      parent_request_id: 'trace-parent-2',
    });

    await dispatcher.dispatch(new TurnEnded({ agentId: 'test-agent', turnId: 4, reason: 'completed' }));
    expect(attribution.of('test-agent').activeRequestId).toBeUndefined();
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

    await request(service, { source: { type: 'turn', turnId: 1, step: 1 } });
    expect(telemetry.getContext()['request_id']).toBe('trace-ambient-2');

    nextRequestId = undefined;
    await request(service, { source: { type: 'turn', turnId: 1, step: 2 } });
    expect(telemetry.getContext()['request_id']).toBeUndefined();
  });

  it('clears the ambient request id after a failed request', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(500, 'boom', true, 'req-1', null, {
          requestId: 'trace-fail-ambient',
        });
      },
    });
    const { service, telemetry } = createService(requester);

    await expect(
      request(service, { source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(telemetry.getContext()['request_id']).toBeUndefined();
  });

  it('keeps operation request ids isolated and resolves compaction metadata from its turn', async () => {
    const metadata: AgentMeta = {
      type: 'sub',
      labels: { parentAgentId: 'main', profileName: 'coder' },
    };
    const { service, dispatcher, telemetry } = createService(
      createTracedRequester('trace-operation-1', { providerType: 'kimi' }),
      { metadata },
    );
    await startMetadataTurn(dispatcher, { kind: 'user' }, 'msg_user');
    await startMetadataTurn(dispatcher, {
      kind: 'cron_job',
      jobId: 'j',
      cron: '* * * * *',
      recurring: true,
      coalescedCount: 1,
      stale: false,
    }, undefined, 2);

    expect(JSON.parse(metadataHeader(service, {
      type: 'operation',
      turnId: 2,
      requestKind: 'full_compaction',
    })!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'cron',
      step_reason: 'compact',
      user_input_id: 'msg_user',
    });
    telemetry.setContext({ request_id: 'trace-turn-1' });
    await request(service, {
      source: { type: 'operation', turnId: 2, requestKind: 'full_compaction' },
    });
    expect(telemetry.getContext()['request_id']).toBe('trace-turn-1');

    await dispatcher.dispatch(new TurnEnded({ agentId: 'test-agent', turnId: 2, reason: 'completed' }));
    expect(JSON.parse(metadataHeader(service, {
      type: 'operation',
      requestKind: 'full_compaction',
    })!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'user',
      step_reason: 'compact',
      user_input_id: 'msg_user',
    });

    const restored = createService(createRequester({ value: 0 }, undefined, [], undefined, { providerType: 'kimi' }), {
      metadata,
    });
    await restoreTestEventDispatcher(restored.dispatcher, recordingWireLog(restored.records), 'wire/llm-requester', [
      new TurnPrompt({
        agentId: 'test-agent',
        turnId: 1,
        origin: { kind: 'user' },
        promptId: 'msg_restored',
        input: [],
      }).serialize(),
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }).serialize(),
    ]);
    expect(restored.attribution.of('test-agent').userInputId).toBe('msg_restored');
    expect(JSON.parse(metadataHeader(restored.service, {
      type: 'operation',
      requestKind: 'full_compaction',
    })!)).toMatchObject({ user_input_id: 'msg_restored' });

    const replayed = createService(createRequester({ value: 0 }, undefined, [], undefined, { providerType: 'kimi' }), {
      metadata,
      parentUserInputId: 'msg_unrelated',
      parentRequestId: 'trace-unrelated',
    });
    await restoreTestEventDispatcher(replayed.dispatcher, recordingWireLog(replayed.records), 'wire/llm-requester', [
      new TurnPrompt({
        agentId: 'test-agent',
        turnId: 1,
        origin: { kind: 'system_trigger', name: 'subagent' },
        input: [],
      }).serialize(),
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }).serialize(),
    ]);
    expect(JSON.parse(metadataHeader(replayed.service, {
      type: 'operation',
      requestKind: 'full_compaction',
    })!)).toEqual({
      agent_role: 'subagent',
      turn_trigger: 'user',
      step_reason: 'compact',
    });
  });
});

describe('AgentLoopRequestFactory media resolver wiring', () => {
  it('runs tool and media resolvers before projection and sends the resolved tools', async () => {
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
    const { service, dispatcher } = createService(requester, {
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

    await request(service);
    await dispatcher.flush();

    expect(toolSelectCalls).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0].map((message) => message.role)).toEqual(['user']);
    expect(resolve.mock.calls[0]?.[1]).toMatchObject(requester.model);
    expect(inputs[0]?.tools).toEqual([resolvedTool]);

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
              { type: 'function', id: 'media2', name: 'ReadMediaFile', arguments: '{}' },
              { type: 'function', id: 'other', name: 'other', arguments: '{}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'media',
            content: [
              { type: 'text', text: '<image path="/tmp/pic.png">' },
              { type: 'image_url', imageUrl: { url: 'kimi-file://media' } },
              { type: 'text', text: '</image>' },
            ],
          },
          { role: 'tool', toolCallId: 'media2', content: [{ type: 'text', text: 'media result' }] },
          { role: 'tool', toolCallId: 'other', content: [{ type: 'text', text: 'other result' }] },
          { role: 'user', content: [{ type: 'text', text: 'continue' }] },
        ],
        toolSelect: { defaultTools: () => [mediaTool, otherTool] },
      });

      await request(service);

      const input = attemptInputs[0]!;
      expect(input.tools).toEqual(imageIn ? [mediaTool, otherTool] : [otherTool]);
      expect(
        input.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls : []).map(
          (call) => call.name,
        ),
      ).toEqual(imageIn ? ['ReadMediaFile', 'ReadMediaFile', 'other'] : ['other']);
      expect(
        input.messages.flatMap((message) => message.role === 'tool' ? [message.toolCallId] : []),
      ).toEqual(imageIn ? ['media', 'media2', 'other'] : ['other']);
      const omissions = input.messages.flatMap((message) =>
        message.role === 'user'
          ? message.content.flatMap((part) =>
              part.type === 'text' && part.text.includes('omitted:') ? [part.text] : [],
            )
          : [],
      );
      expect(omissions).toEqual(imageIn ? [] : [
        '[image omitted: a ReadMediaFile tool result was hidden because the current model does not support image input; use a model with image input capability to view it]\n<image path="/tmp/pic.png"></image>',
      ]);
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

describe('AgentLoopRequestFactory tool call id forwarding', () => {
  it('passes lower-layer unique ids through unchanged', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(
      createScriptedRequester([{ ids: ['call_1', 'call_2'] }]),
    );

    const result = await request(service, {}, (part) => {
      parts.push(part);
    });

    expect(result.message.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect(parts.filter(isToolCall).map((p) => p.id)).toEqual(['call_1', 'call_2']);
  });

  it('preserves lower-layer duplicate id assignments', async () => {
    const { service } = createService(
      createScriptedRequester([
        { ids: ['Bash_0', { id: 'Bash_0__2', rawId: 'Bash_0' }] },
      ]),
    );

    const result = await request(service);

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

    await expect(request(service)).rejects.toThrow('stream boom');
    const retry = await request(service);
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

    const result = await request(service);
    expect(result.message.toolCalls[0]!.id).toBe('Bash_0');
  });
});

describe('AgentLoopRequestFactory attempt retry notification', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies before resending with a repaired projection', async () => {
    const calls = { value: 0 };
    const { service } = createService(createRequester(calls));
    const onAttemptRetry = vi.fn();

    const result = await request(service, { onAttemptRetry });

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

    const promise = request(service, { onAttemptRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls.value).toBe(3);
    expect(onAttemptRetry).toHaveBeenCalledTimes(2);
  });

  it('does not notify when the error is final', async () => {
    const calls = { value: 0 };
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'max_tokens must be positive', false)),
    );
    const onAttemptRetry = vi.fn();

    await expect(request(service, { onAttemptRetry })).rejects.toMatchObject({ statusCode: 400 });
    expect(onAttemptRetry).not.toHaveBeenCalled();
  });
});

describe('core requester stream state across service-internal retries', () => {
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
    const outcomePromise = service.coreRequester({
      source: () => ({ type: 'turn', turnId: 0, step: 0 }),
      runtime: runtimeOf(service),
    }).generate(
      { content: { messages: [] }, profile: {} },
      { signal: new AbortController().signal },
    );

    await vi.runAllTimersAsync();
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }

    const outcome = await outcomePromise;
    if (outcome.type !== 'done') throw new Error(`unexpected outcome: ${outcome.type}`);
    expect(outcome.message.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_b']);
  });
});

describe('core requester', () => {
  async function generateCore(
    service: AgentLoopRequestFactory,
    turnId: number,
    step: number,
    messages: readonly Message[] = history,
    onEvent?: (event: { readonly type: string }) => void,
  ) {
    return service.coreRequester({ source: () => ({ type: 'turn', turnId, step }), runtime: runtimeOf(service) }).generate(
      { content: { messages }, profile: {} },
      { signal: new AbortController().signal, onEvent },
    );
  }

  it('freezes turn configuration, merges policies and retries only in core while side requests stay independent', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, new APIConnectionError('terminated'));
    const base = requester.request.bind(requester);
    requester.request = async function* (input, signal, options) {
      yield {
        type: 'usage',
        usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        model: 'wire-model',
      };
      for await (const event of base(input, signal, options)) {
        yield event.type === 'finish' ? { ...event, requestId: 'trace-core' } : event;
      }
    };
    let systemPrompt = 'frozen-system';
    let temperature = 0.1;
    let modelAlias = 'm';
    const seen: CoreLlmRequest[] = [];
    const extraResolver = {
      id: 'extra-resolver',
      resolve: async (request: (typeof seen)[number]) => {
        seen.push(request);
        return request;
      },
    };
    const prepareForRequest = vi.fn(async () => {});
    const { service, runtime, dispatcher, measuredCalls, usageAliases } = createService(
      { ...requester, model: { ...requester.model, protocol: 'openai' } },
      {
        env: { [KIMI_CODE_INFINITE_RETRY_ENV]: '1' },
        maxAttemptsPerStep: 1,
        modelAlias: () => modelAlias,
        systemPrompt: () => systemPrompt,
        requestParams: () => ({ sampling: { temperature } }),
        toolSelect: { prepareForRequest, initialTools: () => baselineTools },
      },
    );
    const trace: { current?: { requestId?: string } } = {};
    const baselineTools: readonly Tool[] = [{
      name: 'frozen-tool',
      description: 'frozen baseline tool',
      parameters: { type: 'object', properties: {} },
    }];
    expect(service.baselineTools()).toBe(baselineTools);
    const execution = service.createTurnExecution({
      turnId: 7,
      profile: { tools: baselineTools },
      step: () => 2,
      historyRevision: runtime.historyRevision,
      mediaRecovery: runtime.mediaRecovery,
      onTrace: (current) => {
        trace.current = current;
      },
    });
    expect(execution.thinkingEffort).toBe('off');
    modelAlias = 'other';
    systemPrompt = 'changed-system';
    temperature = 0.9;
    const preparedProfile = await execution.prepare!(new AbortController().signal);
    expect(preparedProfile.tools).toBe(baselineTools);
    const core = execution.requester.with({ policy: { resolvers: [extraResolver] } });
    const prepared = core.request({ content: { messages: history, usedTokens: 17 }, profile: execution.profile });
    expect(prepared.profile?.systemPrompt).toBe('frozen-system');
    expect(prepared.profile?.tools).toEqual(baselineTools);
    expect(prepared.model.sampling?.temperature).toBe(0.1);
    expect(prepared.content.usedTokens).toBe(17);
    expect(prepared.policy?.retry).toEqual({ maxAttemptsPerStep: 1, infiniteRetry: true });

    const retries: string[] = [];
    const outcome = await core.generate(
      { content: { messages: history, usedTokens: 17 }, profile: execution.profile },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.retrying') retries.push(event.reason);
        },
      },
    );

    expect(outcome.type).toBe('done');
    expect(calls.value).toBe(2);
    expect(retries).toEqual(['backoff']);
    expect(prepareForRequest).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.profile?.systemPrompt === 'frozen-system')).toBe(true);
    expect(seen.every((request) => request.profile?.tools?.[0]?.name === 'frozen-tool')).toBe(true);
    expect(seen.every((request) => request.model.sampling?.temperature === 0.1)).toBe(true);
    expect(trace.current?.requestId).toBe('trace-core');
    expect(measuredCalls).toHaveLength(1);
    await dispatcher.flush();

    await request(service, { messages: history });
    expect(calls.value).toBe(3);
    expect(usageAliases).toEqual(['m', 'other']);
  });

  it('recovers credentials through the core recovery policy', async () => {
    const calls = { value: 0 };
    const base = createRequester(calls, new APIStatusError(401, 'unauthorized', false));
    const invalidate = vi.fn();
    const requester: ModelEventRequester = {
      ...base,
      model: {
        ...base.model,
        credentialProvider: {
          resolve: () => ({ apiKey: 'test-key' }),
          canRecover: () => true,
          invalidate,
        },
      },
    };
    const { service, dispatcher } = createService(requester);

    const outcome = await generateCore(service, 3, 1);

    expect(outcome.type).toBe('done');
    expect(calls.value).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await dispatcher.flush();
  });

  it('composes structure and media recovery with per-attempt wire projections', async () => {
    const calls = { value: 0 };
    const inputs: ModelRequestInput[] = [];
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'stale' }], toolCalls: [] },
      {
        role: 'user',
        content: ['ONE', 'TWO', 'THREE'].map((data) => ({
          type: 'image_url',
          imageUrl: { url: `data:image/png;base64,${data}` },
        })),
      },
    ];
    const { service, dispatcher, telemetryRecords } = createService(
      createRequester(calls, new APIStatusError(400, 'tool_use ids must be unique', false), [new APIRequestTooLargeError(413, 'too large')], inputs),
      { contextMessages: messages },
    );

    const outcome = await generateCore(service, 4, 2, messages);

    expect(outcome.type).toBe('done');
    expect(calls.value).toBe(3);
    await dispatcher.flush();
    expect(projectionFallbacks(telemetryRecords)).toEqual(['strict', 'media-degraded']);
  });

  it('keeps cache diagnostics and usage measurement on the successful core outcome', async () => {
    const { service, telemetryRecords, measuredCalls } = createService(
      createCacheRequester([cacheUsage(10000), cacheUsage(7000)]),
    );

    await generateCore(service, 5, 1);
    await generateCore(service, 5, 2);

    expect(measuredCalls).toHaveLength(2);
    expect(cacheBreaks(telemetryRecords)).toHaveLength(1);
    expect(cacheBreaks(telemetryRecords)[0]?.properties).toMatchObject({
      request_kind: 'turn',
      turn_id: 5,
      step_no: 2,
      trace_id: 'trace-2',
    });
  });
});
