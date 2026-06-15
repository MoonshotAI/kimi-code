import {
  DEEPSEEK_TOOL_CALLS_BEGIN,
  DeepSeekInlineToolCallFilter,
  parseDeepSeekInlineToolCalls,
} from '#/providers/deepseek-inline-tool-calls';
import { describe, expect, it } from 'vitest';

const SEP = '▁';
const callBlock = (name: string, args: string) =>
  `<|tool${SEP}call${SEP}begin|>function<|tool${SEP}sep|>${name}\n\`\`\`json\n${args}\n\`\`\`<|tool${SEP}call${SEP}end|>`;
const wrap = (...blocks: string[]) =>
  `${DEEPSEEK_TOOL_CALLS_BEGIN}${blocks.join('')}<|tool${SEP}calls${SEP}end|>`;

describe('parseDeepSeekInlineToolCalls', () => {
  it('returns no calls when the begin token is absent', () => {
    expect(parseDeepSeekInlineToolCalls('A plain assistant answer.')).toEqual([]);
    expect(parseDeepSeekInlineToolCalls('')).toEqual([]);
  });

  it('parses a single inline tool call', () => {
    const calls = parseDeepSeekInlineToolCalls(wrap(callBlock('read_file', '{"path": "app.js"}')));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
      arguments: '{"path": "app.js"}',
    });
    expect(typeof calls[0]?.id).toBe('string');
  });

  it('parses parallel inline tool calls in order', () => {
    const calls = parseDeepSeekInlineToolCalls(
      wrap(callBlock('Read', '{"path":"a.js"}'), callBlock('Grep', '{"pattern":"foo"}')),
    );
    expect(calls.map((c) => c.name)).toEqual(['Read', 'Grep']);
    expect(calls.map((c) => c.arguments)).toEqual(['{"path":"a.js"}', '{"pattern":"foo"}']);
  });

  it('skips a call whose argument block is not valid JSON', () => {
    const calls = parseDeepSeekInlineToolCalls(
      wrap(callBlock('Read', '{"path": broken'), callBlock('Grep', '{"pattern":"x"}')),
    );
    expect(calls.map((c) => c.name)).toEqual(['Grep']);
  });
});

describe('DeepSeekInlineToolCallFilter', () => {
  it('passes ordinary text through and never suppresses', () => {
    const f = new DeepSeekInlineToolCallFilter();
    let out = f.push('Hello, ');
    out += f.push('world.');
    out += f.flush();
    expect(out).toBe('Hello, world.');
    expect(f.sawToolBlock).toBe(false);
  });

  it('emits text before the block and suppresses the tokens', () => {
    const f = new DeepSeekInlineToolCallFilter();
    const content = `Reading now. ${wrap(callBlock('read_file', '{"path":"a.js"}'))}`;
    let out = '';
    out += f.push(content);
    out += f.flush();
    expect(out).toBe('Reading now. ');
    expect(f.sawToolBlock).toBe(true);
    expect(f.content).toBe(content);
    expect(parseDeepSeekInlineToolCalls(f.content)).toHaveLength(1);
  });

  it('detects a begin marker split across deltas', () => {
    const f = new DeepSeekInlineToolCallFilter();
    const mid = Math.floor(DEEPSEEK_TOOL_CALLS_BEGIN.length / 2);
    let out = '';
    out += f.push(`ok ${DEEPSEEK_TOOL_CALLS_BEGIN.slice(0, mid)}`);
    out += f.push(`${DEEPSEEK_TOOL_CALLS_BEGIN.slice(mid)}rest`);
    out += f.flush();
    expect(out).toBe('ok ');
    expect(f.sawToolBlock).toBe(true);
  });
});
