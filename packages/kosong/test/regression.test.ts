import { generate } from '#/generate';
import type { Message, StreamedMessagePart } from '#/message';
import { createAssistantMessage, createUserMessage } from '#/message';
import type { ChatProvider, GenerateOptions, StreamedMessage, ThinkingEffort } from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import { describe, expect, it } from 'vitest';

function createMockStream(
  parts: StreamedMessagePart[],
  opts?: { id?: string; usage?: TokenUsage },
): StreamedMessage {
  return {
    get id(): string | null {
      return opts?.id ?? null;
    },
    get usage(): TokenUsage | null {
      return opts?.usage ?? null;
    },
    finishReason: null,
    rawFinishReason: null,
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function createMockProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock-model',
    thinkingEffort: null,
    generate: async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> => stream,
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

describe('regression', () => {
  describe('empty text parts', () => {
    it('standalone empty TextPart is kept in content', async () => {
      const stream = createMockStream([
        { type: 'text', text: 'before' },
        { type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
        { type: 'text', text: '' },
      ]);
      const provider = createMockProvider(stream);

      const result = await generate(provider, '', [], []);

      expect(result.message.content).toEqual([
        { type: 'text', text: 'before' },
        { type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
        { type: 'text', text: '' },
      ]);
    });
  });

  describe('toolCalls defaults', () => {
    it('createUserMessage has toolCalls as empty array (not undefined)', () => {
      const msg = createUserMessage('hello');
      expect(msg.toolCalls).toEqual([]);
    });

    it('createAssistantMessage without toolCalls has empty array', () => {
      const msg = createAssistantMessage([{ type: 'text', text: 'test' }]);
      expect(msg.toolCalls).toEqual([]);
    });

    it('createAssistantMessage with explicit toolCalls preserves them', () => {
      const msg = createAssistantMessage(
        [{ type: 'text', text: 'test' }],
        [
          {
            type: 'function',
            id: 'call-1',
            name: 'search', arguments: '{}',
          },
        ],
      );
      expect(msg.toolCalls).toEqual([
        {
          type: 'function',
          id: 'call-1',
          name: 'search', arguments: '{}',
        },
      ]);
    });

    it('generate() result message has toolCalls as empty array when no tools called', async () => {
      const stream = createMockStream([{ type: 'text', text: 'hi' }]);
      const provider = createMockProvider(stream);

      const result = await generate(provider, '', [], []);
      expect(result.message.toolCalls).toEqual([]);
    });
  });
});
