import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import {
  createShellCommand,
  ShellCommandRef,
  type ShellCommandEvent,
  type ShellCommandFace,
} from '#/features/shellCommand/index';
import { createNodeOsHost } from '#/features/os/host/index';
import { createHarness, harnessInternals, memoryHarnessSpace, type Harness } from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function scriptedRequester(
  next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>,
): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(
  harness: Harness,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? harnessInternals(harness.app).agents.get(session)?.get(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

async function startApp(opts?: { timeoutMs?: number }) {
  const workDir = await mkdtemp(join(tmpdir(), 'shell-command-'));
  const harness = createHarness({ space: memoryHarnessSpace() });
  const shell = createShellCommand({
    workDir,
    timeoutMs: opts?.timeoutMs,
    host: createNodeOsHost(),
  });
  let exposed: Readonly<ShallowRef<ShellCommandFace | undefined>> | undefined;
  const probe = createFeature('shell-command-probe', {
    agent: () => {
      exposed = useInject(ShellCommandRef);
    },
  });
  await harness.app.features.add(shell);
  await harness.app.features.add(probe);
  const session = await harness.app.create({ sessionId: 's1' });
  const agent = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 's1', MAIN_AGENT_ID, scriptedRequester(() => textOutcome('done')));
  const face = (): ShellCommandFace => {
    const value = exposed?.value;
    if (value === undefined) throw new Error('ShellCommandRef was not exposed');
    return value;
  };
  const cleanup = async (): Promise<void> => {
    await harness.close();
    await rm(workDir, { recursive: true, force: true });
  };
  return { harness, session, agent, shell, workDir, face, cleanup };
}

describe('shellCommand feature', () => {
  it('runs a command and emits started/output/completed events in order', async () => {
    const { harness, shell, face, cleanup } = await startApp();
    try {
      const events: ShellCommandEvent[] = [];
      harness.app.on(shell, 'shell.started', (event) => events.push(event));
      harness.app.on(shell, 'shell.output', (event) => events.push(event));
      harness.app.on(shell, 'shell.completed', (event) => events.push(event));

      const result = await face().run({ command: 'echo hello' });

      expect(result).toEqual({ stdout: 'hello\n', stderr: '', isError: false });
      expect(events[0]).toMatchObject({
        type: 'shell.started',
        agentId: MAIN_AGENT_ID,
      });
      const commandId = events[0]?.type === 'shell.started' ? events[0].commandId : '';
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
    const { agent, face, cleanup } = await startApp();
    try {
      const result = await face().run({ command: 'exit 3', commandId: 'cmd-fail' });

      expect(result.isError).toBe(true);
      const reminders = agent.loop.state.inbox.remind;
      const output = reminders.find(
        (entry) => entry.meta?.key === 'shell-command:cmd-fail:output',
      );
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
    const { agent, face, cleanup } = await startApp();
    try {
      await face().run({ command: `echo '<a> & </a>'`, commandId: 'cmd-io' });

      const reminders = agent.loop.state.inbox.remind;
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

      const outcome = await agent.loop.runTurn(user('next'));
      expect(outcome.type).toBe('done');
      await agent.flush();

      const history = agent.view.getState().messages;
      const shellEntries = history.filter(
        (entry) =>
          entry.meta?.source === 'reminder' &&
          (entry.meta.key ?? '').startsWith('shell-command:'),
      );
      expect(shellEntries.map((entry) => entry.meta?.key)).toEqual([
        'shell-command:cmd-io:input',
        'shell-command:cmd-io:output',
      ]);
      expect(extractText(shellEntries[0]!.message)).toContain('<bash-input>');
      expect(extractText(shellEntries[1]!.message)).toContain('<bash-stdout>');
      expect(agent.loop.state.inbox.remind).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('cancels a running command', async () => {
    const { face, cleanup } = await startApp();
    try {
      const pending = face().run({ command: 'sleep 30', commandId: 'cmd-cancel' });
      face().cancel('cmd-cancel');
      const result = await pending;
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('moves a timed-out command to the background and still delivers the output reminder', async () => {
    const { agent, face, cleanup } = await startApp({ timeoutMs: 100 });
    try {
      const result = await face().run({
        command: 'sleep 0.3; echo late-done',
        commandId: 'cmd-slow',
      });
      expect(result.isError).toBe(false);
      expect(result.backgrounded).toBe(true);
      expect(result.stdout).toContain('Command timed out and moved to background');
      expect(result.stdout).toContain('task_id: cmd-slow');
      expect(result.stdout).toContain('status: running');

      const backgrounded = agent.loop.state.inbox.remind.find(
        (entry) => entry.meta?.key === 'shell-command:cmd-slow:backgrounded',
      );
      expect(backgrounded?.message.content[0]?.meta).toEqual({
        kind: 'shell_command',
        phase: 'backgrounded',
      });

      await vi.waitFor(
        () => {
          const output = agent.loop.state.inbox.remind.find(
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
    const { face, cleanup } = await startApp();
    try {
      expect(face().run).toBeTypeOf('function');
      expect(face().cancel).toBeTypeOf('function');
    } finally {
      await cleanup();
    }
  });
});
