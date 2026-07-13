/**
 * Scenario: LLM requester retries once with a recovery projection after a
 * deterministic provider rejection — strict projection for tool-use
 * adjacency / structural rejections, media-stripped projection for
 * image-format rejections (with per-turn stickiness).
 *
 * Responsibilities: assert retry eligibility, strict/stripped-history
 * rebuilding, request recording, and usage accounting. Wiring: real
 * AgentLLMRequesterService with stubbed context memory, projector, context
 * sizing, profile, model, telemetry, and wire/log services. Run:
 * ../../node_modules/.bin/vitest run test/llmRequester/strict-resend.test.ts
 */

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IFaultInjectionService } from '#/agent/faultInjection/faultInjection';
import { FaultInjectionService } from '#/agent/faultInjection/faultInjectionService';
import { AgentLLMRequesterService } from '#/agent/llmRequester/llmRequesterService';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { APIRequestTooLargeError, APIStatusError } from '#/app/llmProtocol/errors';
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

function createModel(calls: { value: number }, firstCallError?: Error | null): Model {
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
      if (calls.value === 1 && firstCallError !== null) {
        throw firstCallError ?? new APIStatusError(400, 'messages: `tool_use` ids must be unique');
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
  projector: Pick<IAgentContextProjectorService, 'project' | 'projectStrict'> &
    Partial<Pick<IAgentContextProjectorService, 'projectMediaDegraded' | 'projectMediaStripped'>>,
  options: { readonly flagEnabled?: boolean } = {},
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
  const usage = { record: () => undefined, status: () => ({}) };
  const context = { get: () => history };
  const tools = { list: () => [] };
  const config: Partial<IConfigService> = {
    get: (() => undefined) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetry = { track: () => undefined, track2: () => undefined };
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    shapeTools: (entries) => entries,
    shapeHistory: (messages) => messages,
  };
  const flagEnabled = options.flagEnabled ?? true;

  ix.stub(IAgentContextMemoryService, context);
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentContextProjectorService, projector);
  ix.stub(IFlagService, { enabled: () => flagEnabled });
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
  ix.set(IFaultInjectionService, new SyncDescriptor(FaultInjectionService));
  ix.set(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));

  return {
    service: ix.get(IAgentLLMRequesterService),
    faultInjection: ix.get(IFaultInjectionService),
  };
}

describe('AgentLLMRequesterService strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strictCalls = 0;
    const { service } = createService(createModel(calls), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    const result = await service.request();

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
    const { service } = createService(model, {
      project: (messages: readonly ContextMessage[]) => messages,
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    await expect(service.request()).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(strictCalls).toBe(0);
  });
});

describe('AgentLLMRequesterService media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );

  it('resends once with the media-stripped projection after an image-format 400', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strictCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(createModel(calls, IMAGE_FORMAT_400), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
      projectMediaStripped: (messages: readonly ContextMessage[]) => {
        strippedCalls += 1;
        return messages;
      },
    });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strictCalls).toBe(0);
    expect(strippedCalls).toBe(1);
  });

  it('keeps later steps of the same turn on the stripped projection', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(createModel(calls, IMAGE_FORMAT_400), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaStripped: (messages: readonly ContextMessage[]) => {
        strippedCalls += 1;
        return messages;
      },
    });

    // Step 1: normal projection rejected, media-stripped resend recovers.
    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strippedCalls).toBe(1);

    // Step 2 of the same turn: the poison is still in the full history, so
    // the request builds from the stripped projection directly — no fresh
    // rejection, no normal projection.
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projectCalls).toBe(1);
    expect(strippedCalls).toBe(2);
  });

  it('does not resend for an unrelated 400', async () => {
    const calls = { value: 0 };
    let strippedCalls = 0;
    const { service } = createService(
      createModel(calls, new APIStatusError(400, 'some other validation problem')),
      {
        project: (messages: readonly ContextMessage[]) => messages,
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaStripped: (messages: readonly ContextMessage[]) => {
          strippedCalls += 1;
          return messages;
        },
      },
    );

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
    expect(strippedCalls).toBe(0);
  });
});

describe('AgentLLMRequesterService media-degraded resend', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');

  it('resends once with the media-degraded projection after an HTTP 413', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(createModel(calls, BODY_TOO_LARGE_413), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaDegraded: (messages: readonly ContextMessage[]) => {
        degradedCalls += 1;
        return messages;
      },
      projectMediaStripped: (messages: readonly ContextMessage[]) => {
        strippedCalls += 1;
        return messages;
      },
    });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);
    expect(strippedCalls).toBe(0);
  });

  it('keeps later steps of the same turn on the degraded projection', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    const { service } = createService(createModel(calls, BODY_TOO_LARGE_413), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaDegraded: (messages: readonly ContextMessage[]) => {
        degradedCalls += 1;
        return messages;
      },
    });

    // Step 1: normal projection rejected with 413, degraded resend recovers.
    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);

    // Step 2 of the same turn: the accumulated media is still in the full
    // history, so the request builds from the degraded projection directly.
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(2);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive'),
      new APIStatusError(422, 'unprocessable'),
    ]) {
      const calls = { value: 0 };
      let degradedCalls = 0;
      const { service } = createService(createModel(calls, error), {
        project: (messages: readonly ContextMessage[]) => messages,
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaDegraded: (messages: readonly ContextMessage[]) => {
          degradedCalls += 1;
          return messages;
        },
      });

      await expect(service.request()).rejects.toBe(error);
      expect(calls.value).toBe(1);
      expect(degradedCalls).toBe(0);
    }
  });
});

describe('AgentLLMRequesterService fault injection (experimental)', () => {
  it('raises an armed request-too-large fault before the provider and recovers via the degraded resend', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    const { service, faultInjection } = createService(createModel(calls, null), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaDegraded: (messages: readonly ContextMessage[]) => {
        degradedCalls += 1;
        return messages;
      },
    });

    faultInjection.arm('request-too-large');
    expect(faultInjection.status().armed).toBe('request-too-large');

    const result = await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    // The fault fired before the provider was contacted, so the model only
    // ever saw the degraded resend.
    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);
    expect(faultInjection.status()).toEqual({
      armed: undefined,
      fired: ['request-too-large'],
    });
  });

  it('raises an armed image-format fault and recovers via the stripped resend, one-shot only', async () => {
    const calls = { value: 0 };
    let strippedCalls = 0;
    const { service, faultInjection } = createService(createModel(calls, null), {
      project: (messages: readonly ContextMessage[]) => messages,
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaStripped: (messages: readonly ContextMessage[]) => {
        strippedCalls += 1;
        return messages;
      },
    });

    faultInjection.arm('image-format');
    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(strippedCalls).toBe(1);
    expect(faultInjection.status().fired).toEqual(['image-format']);

    // One-shot: the next request fires nothing and builds normally.
    const result = await service.request({ source: { type: 'turn', turnId: 2, step: 1 } });
    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(faultInjection.status().fired).toEqual(['image-format']);
  });

  it('refuses to arm when the fault-injection flag is disabled', () => {
    const { faultInjection } = createService(createModel({ value: 0 }, null), {
      project: (messages: readonly ContextMessage[]) => messages,
      projectStrict: (messages: readonly ContextMessage[]) => messages,
    }, { flagEnabled: false });

    expect(() => faultInjection.arm('request-too-large')).toThrow(/disabled/);
    expect(faultInjection.status()).toEqual({ armed: undefined, fired: [] });
  });
});
