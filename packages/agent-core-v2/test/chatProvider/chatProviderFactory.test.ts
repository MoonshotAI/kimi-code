import { afterEach, describe, expect, it } from 'vitest';

import type { Message, Tool } from '#/app/llmProtocol';
import type { ChatProvider, StreamedMessage } from '#/app/llmProtocol/provider';

import { createScopedTestHost } from '#/_base/di/test';
import { IChatProviderFactory } from '#/app/chatProvider';

function stubProvider(): ChatProvider {
  const stream: StreamedMessage = {
    async *[Symbol.asyncIterator]() {
      // empty
    },
    id: null,
    usage: null,
    finishReason: null,
    rawFinishReason: null,
  };
  return {
    name: 'stub',
    modelName: 'stub-model',
    thinkingEffort: null,
    generate(_systemPrompt: string, _tools: Tool[], _history: Message[]): Promise<StreamedMessage> {
      return Promise.resolve(stream);
    },
    withThinking(): ChatProvider {
      return this;
    },
  };
}

describe('ChatProviderFactory', () => {
  it('creates a built-in adapter by type', () => {
    const host = createScopedTestHost();
    afterEach(() => host.app.dispose());
    const factory = host.app.accessor.get(IChatProviderFactory);
    const provider = factory.create({ type: 'kimi', model: 'kimi-model', apiKey: 'sk-test' });
    expect(provider.name).toBe('kimi');
    expect(provider.modelName).toBe('kimi-model');
  });

  it('lets a registered factory override a built-in type', () => {
    const host = createScopedTestHost();
    afterEach(() => host.app.dispose());
    const factory = host.app.accessor.get(IChatProviderFactory);
    const stub = stubProvider();
    factory.register('kimi', () => stub);
    expect(factory.create({ type: 'kimi', model: 'x' })).toBe(stub);
  });
});
