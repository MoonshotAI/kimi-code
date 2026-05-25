import { describe, expect, it } from 'vitest';
import {
  translateContextLines,
  containsUsableMessage,
  analyzeContextContent,
} from '../../src/sessions/translator.js';

describe('translateContextLines', () => {
  it('drops _system_prompt, _checkpoint, _usage markers', () => {
    const lines = [
      '{"role":"_system_prompt","content":"You are ..."}',
      '{"role":"_checkpoint","id":0}',
      '{"role":"_usage","token_count":1234}',
    ];
    expect(translateContextLines(lines)).toEqual([]);
  });

  it('user message with string content is wrapped as a single text part', () => {
    const msgs = translateContextLines(['{"role":"user","content":"hi"}']);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
  });

  it('user message with array content normalizes each part', () => {
    const line = JSON.stringify({
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', url: 'data:image/png;base64,xxx' },
      ],
    });
    const msgs = translateContextLines([line]);
    expect(msgs[0]!.content).toHaveLength(2);
    expect(msgs[0]!.content[1]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,xxx' },
    });
  });

  it('assistant message: renames tool_calls → toolCalls, preserves tool_call id strings', () => {
    const line = JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      tool_calls: [{ type: 'function', id: 'Shell:0', function: { name: 'Shell', arguments: '{}' } }],
    });
    const [msg] = translateContextLines([line]);
    expect(msg!.role).toBe('assistant');
    expect(msg!.toolCalls).toEqual([
      { type: 'function', id: 'Shell:0', function: { name: 'Shell', arguments: '{}' } },
    ]);
  });

  it('tool message: renames tool_call_id → toolCallId, wraps string content as text part', () => {
    const line = JSON.stringify({
      role: 'tool',
      tool_call_id: 'Shell:0',
      content: 'output\n',
    });
    const [msg] = translateContextLines([line]);
    expect(msg!.role).toBe('tool');
    expect(msg!.toolCallId).toBe('Shell:0');
    expect(msg!.content).toEqual([{ type: 'text', text: 'output\n' }]);
    expect(msg!.toolCalls).toEqual([]);
  });

  it('assistant message with null content yields an empty content list, not a phantom ""', () => {
    // A tool-call-only assistant message legitimately has no text content.
    // Stringifying nullish content would emit a text part holding the two
    // literal quote characters, feeding phantom context back to the model.
    const line = JSON.stringify({
      role: 'assistant',
      content: null,
      tool_calls: [
        { type: 'function', id: 'Shell:0', function: { name: 'Shell', arguments: '{}' } },
      ],
    });
    const [msg] = translateContextLines([line]);
    expect(msg!.content).toEqual([]);
  });

  it('user message with omitted content yields an empty content list', () => {
    const [msg] = translateContextLines(['{"role":"user"}']);
    expect(msg!.content).toEqual([]);
  });

  it('skips unknown roles silently', () => {
    expect(translateContextLines(['{"role":"weird","content":"x"}'])).toEqual([]);
  });

  it('skips malformed JSON lines silently and continues', () => {
    const out = translateContextLines([
      'not-json-here',
      '{"role":"user","content":"ok"}',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
  });
});

describe('containsUsableMessage', () => {
  it('false when lines hold only _system_prompt / _checkpoint / _usage markers', () => {
    expect(
      containsUsableMessage([
        '{"role":"_system_prompt","content":"You are ..."}',
        '{"role":"_checkpoint","id":0}',
        '{"role":"_usage","token_count":12}',
      ]),
    ).toBe(false);
  });

  it('false for an empty line list and for blank lines', () => {
    expect(containsUsableMessage([])).toBe(false);
    expect(containsUsableMessage(['', '   ', ''])).toBe(false);
  });

  it('true when a user / assistant / tool row is present', () => {
    expect(containsUsableMessage(['{"role":"user","content":"hi"}'])).toBe(true);
    expect(containsUsableMessage(['{"role":"assistant","content":[]}'])).toBe(true);
    expect(containsUsableMessage(['{"role":"tool","content":"out"}'])).toBe(true);
  });

  it('ignores malformed JSON and unknown roles', () => {
    expect(containsUsableMessage(['not-json', '{"role":"weird"}'])).toBe(false);
    expect(containsUsableMessage(['not-json', '{"role":"user","content":"x"}'])).toBe(true);
  });
});

describe('analyzeContextContent', () => {
  it("'real' when there is at least one user / assistant / tool row", () => {
    expect(analyzeContextContent(['{"role":"user","content":"hi"}'])).toBe('real');
    expect(
      analyzeContextContent([
        '{"role":"_system_prompt","content":"x"}',
        '{"role":"assistant","content":[]}',
      ]),
    ).toBe('real');
  });

  it("'empty' when only markers are present — a cleared / unused session", () => {
    // Parseable JSON, just no migratable conversation.
    expect(
      analyzeContextContent([
        '{"role":"_system_prompt","content":"x"}',
        '{"role":"_checkpoint","id":0}',
        '{"role":"_usage","token_count":12}',
      ]),
    ).toBe('empty');
  });

  it("'empty' on no lines or only blank lines", () => {
    expect(analyzeContextContent([])).toBe('empty');
    expect(analyzeContextContent(['', '   ', ''])).toBe('empty');
  });

  it("'corrupt' when every non-blank line fails to parse", () => {
    // A truncated / disk-corrupted context.jsonl looks like this; we want
    // these surfaced as failures rather than silently counted as skipped.
    expect(analyzeContextContent(['not-json', '{broken', '}}}'])).toBe('corrupt');
  });

  it("'empty' (not 'corrupt') when at least one line parses, even without a usable role", () => {
    // A mostly-broken file that still has one well-formed marker line is not
    // outright corrupt — treat it like an empty session.
    expect(
      analyzeContextContent([
        'not-json',
        '{broken',
        '{"role":"_system_prompt","content":"x"}',
      ]),
    ).toBe('empty');
  });
});
