import { createToolMessage } from '@moonshot-ai/core/llm/message';
import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { project } from '#/agent/loop/projection';
import { toLegacyToolReturn } from '#/tool/executor';
import type { ExecutableToolResult } from '#/tool/toolContract';

const NOTE = '<system>The change is applied; there is no need to Read the file back to check it.</system>';
const CALL_ID = 'call_1';

function calling(name: string): ContextMessage {
  return { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: CALL_ID, name, arguments: '{}' }] };
}

function sentLive(name: string, result: ExecutableToolResult, durationMs?: number): unknown {
  const returned = toLegacyToolReturn(result, name);
  const message = createToolMessage(CALL_ID, returned.content, {
    isError: returned.outcome === 'failed' ? true : undefined,
    durationMs,
  }) as ContextMessage;
  return project([calling(name), message]).at(-1);
}

function sentAfterResume(name: string, result: ExecutableToolResult, durationMs?: number): unknown {
  const output = result.output;
  const message: ContextMessage = {
    ...createToolMessage(CALL_ID, typeof output === 'string' ? output : [...output]),
    isError: result.isError,
    note: result.note,
    durationMs,
  };
  return project([calling(name), message]).at(-1);
}

describe('a tool result with a note', () => {
  it.each<[string, string, ExecutableToolResult, number | undefined]>([
    ['a Write that succeeded', 'Write', { output: 'Wrote 8 bytes to out.txt', note: NOTE }, undefined],
    ['an Edit that succeeded', 'Edit', { output: 'Replaced 1 occurrence in notes.txt', note: NOTE }, undefined],
    ['a failed tool', 'Write', { output: 'Permission denied: out.txt', isError: true, note: NOTE }, undefined],
    ['a tool that shows its wall time', 'Bash', { output: 'done', note: '<system>Output truncated.</system>' }, 1500],
    ['a tool whose output the executor reported as empty', 'Write', { output: 'Tool output is empty.', note: NOTE }, undefined],
  ])('is sent the same after the session is restored as it was live: %s', (_label, name, result, durationMs) => {
    expect(sentAfterResume(name, result, durationMs)).toEqual(sentLive(name, result, durationMs));
  });
});
