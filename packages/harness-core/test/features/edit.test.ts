import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { Message, ToolCall, ToolDescription } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { createEdit, createEditTool } from '#/features/edit/index';
import { createHarness, harnessInternals, memoryHarnessSpace } from '#/runtime/index';
import type { Harness } from '#/runtime/index';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'edit-feature-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runEditResult(args: Record<string, unknown>): Promise<ToolResult> {
  const tool = createEditTool({ workDir });
  return tool.execute({
    toolCall: {
      type: 'function',
      id: 'call-edit',
      name: 'Edit',
      arguments: JSON.stringify(args),
    },
    signal: new AbortController().signal,
  });
}

async function runEdit(args: Record<string, unknown>): Promise<string> {
  return extractText(await runEditResult(args));
}

describe('edit tool', () => {
  it('replaces a unique occurrence and reports the success wording', async () => {
    const file = join(workDir, 'a.txt');
    await writeFile(file, 'alpha beta');

    const output = await runEdit({ path: file, old_string: 'beta', new_string: 'gamma' });

    expect(output).toBe(`Replaced 1 occurrence in ${file}`);
    expect(await readFile(file, 'utf8')).toBe('alpha gamma');
  });

  it('rejects no-op edits before touching the file', async () => {
    const file = join(workDir, 'a.txt');
    await writeFile(file, 'same');

    const result = await runEditResult({ path: file, old_string: 'same', new_string: 'same' });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      'No changes to make: old_string and new_string are exactly the same.',
    );
    expect(await readFile(file, 'utf8')).toBe('same');
  });

  it('reports old_string not found with the trailing-newline message', async () => {
    const file = join(workDir, 'a.txt');
    await writeFile(file, 'alpha beta');

    const result = await runEditResult({ path: file, old_string: 'delta', new_string: 'gamma' });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      `old_string not found in ${file}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`,
    );
    expect(await readFile(file, 'utf8')).toBe('alpha beta');
  });

  it('reports old_string not unique with the occurrence count', async () => {
    const file = join(workDir, 'a.txt');
    await writeFile(file, 'same same');

    const result = await runEditResult({ path: file, old_string: 'same', new_string: 'other' });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      `old_string is not unique in ${file} (found 2 occurrences). To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.`,
    );
    expect(await readFile(file, 'utf8')).toBe('same same');
  });

  it('replace_all replaces every occurrence', async () => {
    const file = join(workDir, 'a.txt');
    await writeFile(file, 'a b a');

    const output = await runEdit({
      path: file,
      old_string: 'a',
      new_string: 'x',
      replace_all: true,
    });

    expect(output).toBe(`Replaced 2 occurrences in ${file}`);
    expect(await readFile(file, 'utf8')).toBe('x b x');
  });

  it('matches a pure CRLF file through the LF view and writes back CRLF', async () => {
    const file = join(workDir, 'crlf.txt');
    await writeFile(file, 'alpha\r\nbeta\r\ngamma\r\n');

    const output = await runEdit({ path: file, old_string: 'alpha\nbeta', new_string: 'one\ntwo' });

    expect(output).toBe(`Replaced 1 occurrence in ${file}`);
    expect(await readFile(file, 'utf8')).toBe('one\r\ntwo\r\ngamma\r\n');
  });

  it('reports is-not-a-file when the path resolves to a directory', async () => {
    const result = await runEditResult({ path: workDir, old_string: 'a', new_string: 'b' });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(`${workDir} is not a file.`);
  });

  it('resolves relative paths against the working directory', async () => {
    await writeFile(join(workDir, 'note.txt'), 'hello world');

    const output = await runEdit({ path: 'note.txt', old_string: 'world', new_string: 'there' });

    expect(output).toBe('Replaced 1 occurrence in note.txt');
    expect(await readFile(join(workDir, 'note.txt'), 'utf8')).toBe('hello there');
  });

  it('refuses to edit a sensitive file', async () => {
    await writeFile(join(workDir, '.env'), 'SECRET=1');

    const result = await runEditResult({ path: '.env', old_string: 'SECRET', new_string: 'MASKED' });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      '".env" matches a sensitive-file pattern (env / credential / SSH key). Access is blocked to protect secrets.',
    );
    expect(await readFile(join(workDir, '.env'), 'utf8')).toBe('SECRET=1');
  });

  it('requires an absolute path outside the working directory', async () => {
    const result = await runEditResult({ path: '../outside.txt', old_string: 'a', new_string: 'b' });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toBe(
      '"../outside.txt" is not an absolute path. You must provide an absolute path to write or edit a file outside the working directory.',
    );
  });
});

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(script: LlmScript): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const requester: LoopLlmRequester = {
    with: () => requester,
    request: (part) => part as unknown as LlmRequest,
    generate: (rest: GenerateRest) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      if ('toolCall' in out) {
        return Promise.resolve(
          textOutcome('', [
            {
              type: 'function',
              id: `call-${calls.length}`,
              name: out.toolCall.name,
              arguments: out.toolCall.arguments,
            },
          ]),
        );
      }
      return Promise.resolve(textOutcome(out.text));
    },
  };
  return { requester, calls };
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

describe('edit feature', () => {
  it('runs an Edit tool call inside a turn and edits the file', async () => {
    await writeFile(join(workDir, 'target.txt'), 'foo baz');
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      if (last !== undefined && last.role === 'tool') return { text: 'done' };
      return {
        toolCall: {
          name: 'Edit',
          arguments: JSON.stringify({ path: 'target.txt', old_string: 'foo', new_string: 'bar' }),
        },
      };
    };
    const { requester, calls } = createMockRequester(script);
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createEdit({ workDir }));
    const session = await harness.app.create({ sessionId: 'sess' });
    const agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'main-host' });
    setRequester(harness, 'sess', 'main', requester);
    try {
      const outcome = await agent.loop.runTurn(
        createUserEntry(createUserMessage('edit the file'), { source: 'input' }),
      );
      expect(outcome.type).toBe('done');
      await agent.flush();

      expect(await readFile(join(workDir, 'target.txt'), 'utf8')).toBe('bar baz');

      const editSpec = calls[0]?.tools.find((tool) => tool.name === 'Edit');
      expect(editSpec?.parameters).toMatchObject({
        type: 'object',
        required: ['path', 'old_string', 'new_string'],
      });

      const toolMessage = calls[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage !== undefined && extractText(toolMessage)).toBe(
        'Replaced 1 occurrence in target.txt',
      );
    } finally {
      await harness.close();
    }
  });
});
