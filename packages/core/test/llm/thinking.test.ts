import { describe, expect, it } from 'vitest';

import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/protocol';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { createAssistantMessage } from '#/llm/message';
import type { LlmModelSpec, LlmRequestModel, ModelThinkingMetadata } from '#/llm/request';
import {
  defaultThinkingEffortForModel,
  modelSupportsThinking,
  resolveThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
} from '#/llm/thinking';

import { TEST_MODEL, testModule } from './harness';

function modelWith(thinking?: ModelThinkingMetadata): LlmModelSpec {
  return {
    provider: 'test',
    name: 'test-model',
    capability: { thinking: true },
    thinking,
  };
}

function requestModel(
  thinking: LlmRequestModel['thinking'],
  metadata?: ModelThinkingMetadata,
): LlmRequestModel {
  return { spec: modelWith(metadata), thinking };
}

describe('thinking defaults and keep', () => {
  it('as a model user, I want model defaults, explicit thinking requests and strict fallbacks resolved consistently', () => {
    const declared = modelWith({ supportEfforts: ['low', 'medium', 'high'], defaultEffort: 'high' });
    expect(modelSupportsThinking(declared)).toBe(true);
    expect(modelSupportsThinking({ provider: 'test', name: 'plain' })).toBe(false);
    expect(defaultThinkingEffortForModel(declared)).toBe('high');
    expect(defaultThinkingEffortForModel(modelWith({ supportEfforts: ['low', 'medium', 'high'] })))
      .toBe('medium');
    expect(defaultThinkingEffortForModel({ provider: 'test', name: 'plain' })).toBe('off');

    expect(resolveThinkingEffortForModel(' Max ', undefined, declared)).toBe('max');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, declared)).toBe('off');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'low' }, declared)).toBe('low');
    expect(resolveThinkingEffortForModel('high', { enabled: false }, declared)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, undefined, declared)).toBe('high');
    expect(resolveThinkingEffortForModel('max', undefined, declared, true)).toBe('high');
    expect(resolveThinkingEffortForModel('on', undefined, declared, true)).toBe('high');
    expect(resolveThinkingEffortForModel('off', undefined, declared, true)).toBe('off');

    const always = modelWith({ supportEfforts: ['low', 'high'], alwaysThinking: true });
    expect(resolveThinkingEffortForModel('off', undefined, always)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false, effort: 'low' }, always))
      .toBe('low');
  });

  it('as a model user, I want thinking keep resolved with effort, environment and config precedence', () => {
    expect(resolveThinkingKeep(undefined, undefined, 'high')).toBe('all');
    expect(resolveThinkingKeep(undefined, undefined, 'off')).toBeUndefined();
    expect(resolveThinkingKeep('0', 'all', 'high')).toBeUndefined();
    expect(resolveThinkingKeep(undefined, 'none', 'high')).toBeUndefined();
    expect(resolveThinkingKeep('2', 'all', 'high')).toBe('2');
    expect(resolveThinkingKeep(undefined, '1', 'high')).toBe('1');
  });

  it('as a model user, I want unsupported thinking efforts and unsatisfiable off requests rejected with actionable guidance', () => {
    const unsupported = resolveThinkingEffort(
      { effort: 'high' },
      { provider: 'test', name: 'plain', capability: { thinking: false } },
    );
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'thinking-unsupported', message: expect.stringContaining('does not support') },
    });

    const invalidEffort = resolveThinkingEffort(
      { effort: 'max' },
      modelWith({ supportEfforts: ['low', 'high'] }),
      true,
    );
    expect(invalidEffort).toMatchObject({
      ok: false,
      error: { code: 'effort-unsupported', message: expect.stringContaining('low, high') },
    });

    const always = resolveThinkingEffort(
      { effort: 'off' },
      modelWith({ supportEfforts: ['low', 'high'], alwaysThinking: true }),
    );
    expect(always).toMatchObject({
      ok: false,
      error: { code: 'thinking-cannot-disable', message: expect.stringContaining('always reasons') },
    });

    const noOffEffort = resolveThinkingEffort(
      { effort: 'off' },
      modelWith({ supportEfforts: ['low', 'high'] }),
    );
    expect(noOffEffort).toMatchObject({
      ok: false,
      error: { code: 'off-needs-offeffort', message: expect.stringContaining('offEffort') },
    });
  });
});

describe('thinking protocol encoding', () => {
  it('as a Kimi user, I want on, off and concrete thinking efforts encoded at the top level', () => {
    expect(kimiOpenAIProtocol.encode(testModule({
      model: requestModel({ effort: 'off' }),
    })).params).toMatchObject({ thinking: { type: 'disabled' } });
    expect(kimiOpenAIProtocol.encode(testModule({
      model: requestModel({ effort: 'on' }),
    })).params).toMatchObject({ thinking: { type: 'enabled' } });
    expect(kimiOpenAIProtocol.encode(testModule({
      model: requestModel(
        { effort: 'high', keep: 'all' },
        { supportEfforts: ['low', 'medium', 'high'] },
      ),
      options: { extras: { extra_body: { trace_id: 't1' } } },
    })).params).toMatchObject({
      thinking: { type: 'enabled', effort: 'high', keep: 'all' },
      trace_id: 't1',
    });
  });

  it('as an OpenAI user, I want reasoning_effort used only for concrete efforts without a custom strategy', () => {
    const high = openAIProtocol.encode(testModule({
      model: requestModel({ effort: 'high' }),
    })).params;
    expect(high).toMatchObject({ reasoning_effort: 'high' });
    expect(high).not.toHaveProperty('thinking');

    const on = openAIProtocol.encode(testModule({
      model: requestModel({ effort: 'on' }),
    })).params;
    expect(on).not.toHaveProperty('reasoning_effort');
    expect(on).not.toHaveProperty('thinking');

    const off = openAIProtocol.encode(testModule({
      model: requestModel(
        { effort: 'off' },
        { supportEfforts: ['low', 'high'], offEffort: 'none' },
      ),
    })).params;
    expect(off).toMatchObject({ reasoning_effort: 'none' });
  });

  it('as a user, I want history thinking preserved only when keep is all and thinking is enabled', () => {
    const messages = [createAssistantMessage([{ type: 'text', text: 'hello' }])];
    const reasoningContent = (thinking: LlmRequestModel['thinking']): unknown => {
      const encoded = kimiOpenAIProtocol.encode(testModule({
        model: { ...TEST_MODEL, spec: modelWith(), thinking },
        messages,
      }));
      const assistant = encoded.params.messages[0];
      return assistant !== undefined && 'reasoning_content' in assistant
        ? assistant.reasoning_content
        : undefined;
    };
    expect(reasoningContent({ effort: 'on', keep: 'all' })).toBe('');
    expect(reasoningContent({ effort: 'off', keep: 'all' })).toBeUndefined();
    expect(reasoningContent({ effort: 'on' })).toBeUndefined();
    expect(reasoningContent({ effort: 'on', keep: '1' })).toBeUndefined();
  });

  it('as a user, I want invalid thinking rejected before a request can be encoded', () => {
    expect(() => openAIProtocol.encode(testModule({
      model: {
        spec: { provider: 'test', name: 'plain', capability: { thinking: false } },
        thinking: { effort: 'high' },
      },
    }))).toThrow(/does not support thinking/);
    expect(() => openAIProtocol.encode(testModule({
      model: requestModel(
        { effort: 'off' },
        { supportEfforts: ['low', 'high'], alwaysThinking: true },
      ),
    }))).toThrow(/always reasons/);
  });
});
