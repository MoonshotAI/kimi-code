import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
  useAgent,
  useAgentTools,
  type AgentHandle,
  type FeatureSpec,
  type AgentLlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

import {
  createShellCommand,
  ShellCommandRef,
  type ShellCommandEvent,
} from '#/features/shellCommand/index';
import { createNodeOsHost } from '#/features/os/host/index';

import { fakeRequester, textOutcome, testModel } from '../fake-llm';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: fakeRequester((rest, onEvent) => {
        const call: LlmCall = {
          systemPrompt: rest.profile?.systemPrompt,
          messages: rest.content?.messages ?? [],
          tools: rest.profile?.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        if ('toolCall' in out) {
          return textOutcome('', [
            { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          ]);
        }
        return textOutcome(out.text);
      }),
  };
}

const script: LlmScript = (call) => {
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  return { toolCall: { name: 'Read', arguments: '{}' } };
};

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }] }),
      });
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

async function startApp(opts?: { timeoutMs?: number }) {
  const workDir = await mkdtemp(join(tmpdir(), 'shell-command-'));
  const env = await testStores();
  const { requester } = createMockRequester(script);
  const shell = createShellCommand({ workDir, timeoutMs: opts?.timeoutMs, host: createNodeOsHost() });
  const app = createHarness({ features: [shell, bindTestTools(), bindTestLlm(requester)] });
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const cleanup = async (): Promise<void> => {
    await app.disposeAsync();
    await env.stores.dispose();
    await rm(workDir, { recursive: true, force: true });
  };
  return { app, env, main, session, shell, workDir, cleanup };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

describe('shellCommand feature', () => {
  it('runs a command and emits started/output/completed events in order', async () => {
    const { session, main, shell, cleanup } = await startApp();
    try {
      const events: ShellCommandEvent[] = [];
      session.on(shell, 'shell.started', (event) => events.push(event));
      session.on(shell, 'shell.output', (event) => events.push(event));
      session.on(shell, 'shell.completed', (event) => events.push(event));

      const face = main.resolve(ShellCommandRef);
      const result = await face.run({ command: 'echo hello' });

      expect(result).toEqual({ stdout: 'hello\n', stderr: '', isError: false });
      expect(events[0]).toMatchObject({
        type: 'shell.started',
        agentId: MAIN_AGENT_ID,
      });
      const commandId = events[0]?.commandId ?? '';
      expect(commandId).toMatch(/^shell-command-[0-9a-f]{12}$/);
      expect(events.filter((event) => event.type === 'shell.output')).toEqual([
        expect.objectContaining({ commandId, stream: 'stdout', text: 'hello\n' }),
      ]);
      expect(events.at(-1)).toMatchObject({
        type: 'shell.completed',
        agentId: MAIN_AGENT_ID,
        commandId,
        isError: false,
      });
    } finally {
      await cleanup();
    }
  });

  it('reports isError for a non-zero exit and marks the output reminder meta', async () => {
    const { main, cleanup } = await startApp();
    try {
      const face = main.resolve(ShellCommandRef);
      const result = await face.run({ command: 'exit 3', commandId: 'cmd-fail' });

      expect(result.isError).toBe(true);
      const reminders = main.snapshot.value?.context.reminders ?? [];
      const output = reminders.find((entry) => entry.meta?.key === 'shell-command:cmd-fail:output');
      expect(output?.message.content[0]?.meta).toEqual({
        kind: 'shell_command',
        phase: 'output',
        isError: true,
      });
    } finally {
      await cleanup();
    }
  });

  it('injects escaped bash input/output reminders that ride into history on the next turn', async () => {
    const { env, main, cleanup } = await startApp();
    try {
      const face = main.resolve(ShellCommandRef);
      await face.run({ command: `echo '<a> & </a>'`, commandId: 'cmd-io' });

      const reminders = main.snapshot.value?.context.reminders ?? [];
      expect(reminders.map((entry) => entry.meta?.key)).toEqual([
        'shell-command:cmd-io:input',
        'shell-command:cmd-io:output',
      ]);
      const input = reminders[0]!;
      expect(extractText(input.message)).toBe(
        `<bash-input>\necho '&lt;a&gt; &amp; &lt;/a&gt;'\n</bash-input>`,
      );
      expect(input.message.content[0]?.meta).toEqual({ kind: 'shell_command', phase: 'input' });
      const output = reminders[1]!;
      expect(output.message.content[0]?.meta).toEqual({ kind: 'shell_command', phase: 'output' });
      expect(extractText(output.message)).toBe(
        '<bash-stdout>&lt;a&gt; &amp; &lt;/a&gt;\n</bash-stdout><bash-stderr></bash-stderr>',
      );

      const done = nextTurnDone(main);
      main.submit(createUserMessage('next'));
      await done;
      await env.stores.flush();

      const history = env.stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
      const shellEntries = history.filter(
        (entry) =>
          entry.meta?.source === 'reminder' && (entry.meta.key ?? '').startsWith('shell-command:'),
      );
      expect(shellEntries.map((entry) => entry.meta?.key)).toEqual([
        'shell-command:cmd-io:input',
        'shell-command:cmd-io:output',
      ]);
      expect(extractText(shellEntries[0]!.message)).toContain('<bash-input>');
      expect(extractText(shellEntries[1]!.message)).toContain('<bash-stdout>');
      expect(main.snapshot.value?.context.reminders).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('cancels a running command', async () => {
    const { main, cleanup } = await startApp();
    try {
      const face = main.resolve(ShellCommandRef);
      const pending = face.run({ command: 'sleep 30', commandId: 'cmd-cancel' });
      face.cancel('cmd-cancel');
      const result = await pending;
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('moves a timed-out command to the background and still delivers the output reminder', async () => {
    const { main, cleanup } = await startApp({ timeoutMs: 100 });
    try {
      const face = main.resolve(ShellCommandRef);
      const result = await face.run({ command: 'sleep 0.3; echo late-done', commandId: 'cmd-slow' });
      expect(result.isError).toBe(false);
      expect(result.backgrounded).toBe(true);
      expect(result.stdout).toContain('Command timed out and moved to background');
      expect(result.stdout).toContain('task_id: cmd-slow');
      expect(result.stdout).toContain('status: running');

      const backgrounded = main.snapshot.value?.context.reminders.find(
        (entry) => entry.meta?.key === 'shell-command:cmd-slow:backgrounded',
      );
      expect(backgrounded?.message.content[0]?.meta).toEqual({
        kind: 'shell_command',
        phase: 'backgrounded',
      });

      await vi.waitFor(
        () => {
          const output = main.snapshot.value?.context.reminders.find(
            (entry) => entry.meta?.key === 'shell-command:cmd-slow:output',
          );
          expect(output).toBeDefined();
          expect(extractText(output!.message)).toContain('late-done');
          expect(output?.message.content[0]?.meta).toEqual({
            kind: 'shell_command',
            phase: 'output',
          });
        },
        { timeout: 5000 },
      );
    } finally {
      await cleanup();
    }
  });

  it('exposes the shell command facade from the agent node', async () => {
    const { main, cleanup } = await startApp();
    try {
      const face = main.resolve(ShellCommandRef);
      expect(face.run).toBeTypeOf('function');
      expect(face.cancel).toBeTypeOf('function');
    } finally {
      await cleanup();
    }
  });
});
