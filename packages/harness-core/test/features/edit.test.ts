import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  type AgentHandle,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
  type ToolResult,
} from '@moonshot-ai/agent-core';

import { createEdit, createEditTool } from '#/features/edit/index';
import { createNodeOsHost } from '#/features/os/host/index';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'edit-feature-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runEditResult(args: Record<string, unknown>): Promise<ToolResult> {
  const tool = createEditTool({ workDir, host: createNodeOsHost() });
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
    expect(extractText(result)).toBe('No changes to make: old_string and new_string are exactly the same.');
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

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: LlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: {
      generate: async (_config, content, { onEvent }) => {
        const call: LlmCall = {
          systemPrompt: content.systemPrompt,
          messages: content.messages,
          tools: content.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        if ('toolCall' in out) {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
        }
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        onEvent?.({ type: 'llm.done' });
      },
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
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
    const env = await testStores();
    const { requester, calls } = createMockRequester(script);
    const app = createHarness({ features: [createEdit({ workDir, host: createNodeOsHost() }), bindTestLlm(requester)] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    try {
      const done = nextTurnDone(main);
      main.submit(createUserMessage('edit the file'));
      await done;

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
      await app.disposeAsync();
      await env.stores.dispose();
    }
  });
});
