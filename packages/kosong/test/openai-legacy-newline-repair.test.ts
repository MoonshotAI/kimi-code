import { describe, expect, it, vi } from 'vitest';

import type { StreamedMessagePart, TextPart } from '#/message';
import {
  isAlibabaGateway,
  isStructuralNewline,
  OpenAILegacyChatProvider,
  repairFullText,
} from '#/providers/openai-legacy';

const ALIBABA_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

describe('isAlibabaGateway', () => {
  it('matches token-plan maas gateway', () => {
    expect(isAlibabaGateway(ALIBABA_BASE_URL)).toBe(true);
  });
  it('matches dashscope gateway', () => {
    expect(isAlibabaGateway('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(true);
  });
  it('does not match openai', () => {
    expect(isAlibabaGateway('https://api.openai.com/v1')).toBe(false);
  });
  it('does not match deepseek', () => {
    expect(isAlibabaGateway('https://api.deepseek.com')).toBe(false);
  });
  it('returns false for undefined', () => {
    expect(isAlibabaGateway(undefined)).toBe(false);
  });
});

describe('isStructuralNewline', () => {
  it('empty prev or next line is structural', () => {
    expect(isStructuralNewline('', 'hello')).toBe(true);
    expect(isStructuralNewline('hello', '')).toBe(true);
  });
  it('next line heading / list / quote / table / fence is structural', () => {
    expect(isStructuralNewline('text', '## Title')).toBe(true);
    expect(isStructuralNewline('text', '- item')).toBe(true);
    expect(isStructuralNewline('text', '  * item')).toBe(true);
    expect(isStructuralNewline('text', '1. item')).toBe(true);
    expect(isStructuralNewline('text', '> quote')).toBe(true);
    expect(isStructuralNewline('text', '| col |')).toBe(true);
    expect(isStructuralNewline('text', '```ts')).toBe(true);
  });
  it('prev line heading is structural', () => {
    expect(isStructuralNewline('## Title', 'Some text')).toBe(true);
  });
  it('horizontal rule is structural', () => {
    expect(isStructuralNewline('text', '---')).toBe(true);
    expect(isStructuralNewline('text', '***')).toBe(true);
  });
  it('plain inline continuation is NOT structural', () => {
    expect(isStructuralNewline('- 裁剪决策已写入文件，', '后续同步遇到新增')).toBe(false);
    expect(isStructuralNewline('| ur/ee2/saas.git |', '✓ cacd2b |')).toBe(false);
  });
});

describe('repairFullText', () => {
  it('leaves single line unchanged', () => {
    expect(repairFullText('hello world')).toBe('hello world');
  });
  it('merges list item continuation lines', () => {
    expect(repairFullText('- 裁剪决策已写入文件，\n后续同步遇到新增\n应用可直接查阅'))
      .toBe('- 裁剪决策已写入文件， 后续同步遇到新增 应用可直接查阅');
  });
  it('merges a broken table row', () => {
    const input = '| 仓库 | 状态 |\n|------|------|\n| ur/ee2/saas.git |\n✓ cacd2b |';
    const expected = '| 仓库 | 状态 |\n|------|------|\n| ur/ee2/saas.git | ✓ cacd2b |';
    expect(repairFullText(input)).toBe(expected);
  });
  it('preserves normal list items', () => {
    const input = '- item1\n- item2\n- item3';
    expect(repairFullText(input)).toBe(input);
  });
  it('preserves paragraph separation', () => {
    expect(repairFullText('para1\n\npara2')).toBe('para1\n\npara2');
  });
  it('preserves heading followed by body', () => {
    expect(repairFullText('## Title\nSome text')).toBe('## Title\nSome text');
  });
  it('preserves fenced code block', () => {
    const input = '```\nline1\nline2\n```';
    expect(repairFullText(input)).toBe(input);
  });
  it('preserves code block embedded in text', () => {
    const input = 'before\n```js\nconst a = 1\nconst b = 2\n```\nafter';
    expect(repairFullText(input)).toBe(input);
  });
  it('preserves ordered list', () => {
    const input = '1. first\n2. second\n3. third';
    expect(repairFullText(input)).toBe(input);
  });
  it('handles mixed heading and broken table', () => {
    const input = '## 推送结果\n\n| 仓库 | 状态 |\n|------|------|\n| saas.git |\n✓ done |';
    const expected = '## 推送结果\n\n| 仓库 | 状态 |\n|------|------|\n| saas.git | ✓ done |';
    expect(repairFullText(input)).toBe(expected);
  });
});

describe('Alibaba gateway newline repair (provider integration)', () => {
  function mockStream(provider: OpenAILegacyChatProvider, deltas: string[]): void {
    async function* mockedStream(): AsyncIterable<Record<string, unknown>> {
      for (const content of deltas) {
        yield { id: 'c1', choices: [{ index: 0, delta: { content } }] };
      }
      yield { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    }
    (provider as any)._client.chat.completions.create = vi
      .fn()
      .mockResolvedValue(mockedStream());
  }

  async function collectText(provider: OpenAILegacyChatProvider): Promise<string> {
    const stream = await provider.generate('', [], [
      { role: 'user', content: [{ type: 'text', text: 'q' }], toolCalls: [] },
    ]);
    const parts: StreamedMessagePart[] = [];
    for await (const part of stream) parts.push(part);
    return parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('');
  }

  it('repairs inline newlines for Alibaba baseUrl (streaming)', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'qwen3.8-max-preview',
      apiKey: 'test-key',
      baseUrl: ALIBABA_BASE_URL,
      stream: true,
    });
    mockStream(provider, ['- 裁剪决策已写入文件，\n', '后续同步遇到新增\n', '应用可直接查阅']);
    expect(await collectText(provider)).toBe('- 裁剪决策已写入文件， 后续同步遇到新增 应用可直接查阅');
  });

  it('does NOT repair for non-Alibaba baseUrl (streaming)', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      stream: true,
    });
    mockStream(provider, ['- 裁剪决策已写入文件，\n', '后续同步遇到新增\n', '应用可直接查阅']);
    expect(await collectText(provider)).toBe('- 裁剪决策已写入文件，\n后续同步遇到新增\n应用可直接查阅');
  });

  it('preserves structural newlines for Alibaba baseUrl (streaming)', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'qwen3.8-max-preview',
      apiKey: 'test-key',
      baseUrl: ALIBABA_BASE_URL,
      stream: true,
    });
    mockStream(provider, ['- item1\n', '- item2\n', '- item3']);
    expect(await collectText(provider)).toBe('- item1\n- item2\n- item3');
  });
});
