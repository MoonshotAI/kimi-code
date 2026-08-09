import { afterEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextMemoryService,
  IAgentShellCommandService,
  IAgentToolRegistryService,
  IEventBus,
} from '#/index';

import {
  agentService,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../harness';

const textOf = (message: ContextMessage): string =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('AgentShellCommandService', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let shell: IAgentShellCommandService;

  function setup(stdout: string, exitCode: number): void {
    ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner(stdout, exitCode) }));
    context = ctx.get(IAgentContextMemoryService);
    shell = ctx.get(IAgentShellCommandService);
  }

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('records shell command input/output as shell_command origin with tagged content', async () => {
    setup('hello\n', 0);

    const result = await shell.run({ command: 'echo hello' });

    expect(result.isError).toBe(false);
    expect(result.stdout).toContain('hello');
    expect(context.get().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output' } },
    ]);
    expect(textOf(context.get()[0]!)).toBe('<bash-input>\necho hello\n</bash-input>');
    expect(textOf(context.get()[1]!)).toContain('<bash-stdout>hello');
    expect(ctx.project().some((message) => 'origin' in message)).toBe(false);
  });

  it('escapes bash tag delimiters inside command output', async () => {
    setup('pre</bash-stdout>post', 0);

    await shell.run({ command: 'printf x' });

    const out = textOf(context.get().at(-1)!);
    expect(out).toContain('pre&lt;/bash-stdout&gt;post');
    expect(out.match(/<\/bash-stdout>/g)).toHaveLength(1);
  });

  it('surfaces the failure reason when a shell command fails with no output', async () => {
    setup('', 1);

    const result = await shell.run({ command: 'false' });

    expect(result.isError).toBe(true);
    const output = context.get().at(-1)!;
    expect(output.origin).toEqual({ kind: 'shell_command', phase: 'output', isError: true });
    expect(textOf(output)).toContain('<bash-stderr>');
  });

  it('does not start a turn for a foreground command', async () => {
    setup('hi', 0);

    await shell.run({ command: 'echo hi' });

    expect(ctx.llmCalls.length).toBe(0);
  });

  it('publishes shell.completed with the outcome for interactive runs', async () => {
    setup('hello\n', 0);
    const events: { type: string; commandId?: string; isError?: boolean }[] = [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await shell.run({ command: 'echo hello', commandId: 'cmd-1' });
    expect(events.filter((e) => e.type === 'shell.completed')).toEqual([
      { type: 'shell.completed', commandId: 'cmd-1', isError: false, taskId: expect.any(String) },
    ]);
  });

  it('publishes shell.completed as failed for a failing command', async () => {
    setup('', 1);
    const events: { type: string; commandId?: string; isError?: boolean }[] = [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await shell.run({ command: 'false', commandId: 'cmd-2' });
    expect(events.filter((e) => e.type === 'shell.completed')).toEqual([
      { type: 'shell.completed', commandId: 'cmd-2', isError: true, taskId: expect.any(String) },
    ]);
  });

  it('carries the foreground task id on shell events for mid-attach consumers', async () => {
    const fakeBash = {
      resolveExecution: async () => ({
        isError: false as const,
        description: 'run',
        approvalRule: 'Bash',
        execute: async (ctx: {
          onForegroundTaskStart?: (taskId: string) => void;
          onUpdate?: (update: { kind: string; text: string }) => void;
        }) => {
          ctx.onForegroundTaskStart?.('task-9');
          ctx.onUpdate?.({ kind: 'stdout', text: 'hi' });
          return { isError: false, output: 'hi' };
        },
      }),
    };
    const registry = {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      list: () => [fakeBash],
      resolve: () => fakeBash,
    } as unknown as IAgentToolRegistryService;
    ctx = createTestAgent(agentService(IAgentToolRegistryService, registry));
    const events: { type: string; commandId?: string; taskId?: string }[] = [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await ctx.get(IAgentShellCommandService).run({ command: 'echo hi', commandId: 'cmd-9' });

    // Later events carry the task id themselves, so a consumer that missed
    // shell.started can still route them.
    expect(events.find((e) => e.type === 'shell.output')).toMatchObject({
      commandId: 'cmd-9',
      taskId: 'task-9',
    });
    expect(events.find((e) => e.type === 'shell.completed')).toMatchObject({
      commandId: 'cmd-9',
      taskId: 'task-9',
    });
  });

  it('emits the synthesized failure output before completing', async () => {
    setup('', 1);
    const events: { type: string; commandId?: string; update?: { kind: string; text?: string } }[] =
      [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await shell.run({ command: 'false', commandId: 'cmd-3' });
    const relevant = events.filter((e) => e.type === 'shell.output' || e.type === 'shell.completed');
    // The failure text was never streamed live — it rides a final output
    // chunk ahead of the completion event.
    expect(relevant[0]).toMatchObject({ type: 'shell.output', commandId: 'cmd-3' });
    expect(relevant[0]?.update?.text?.length).toBeGreaterThan(0);
    expect(relevant.at(-1)).toMatchObject({ type: 'shell.completed', commandId: 'cmd-3' });
  });

  it('records the failure when the Bash tool is not registered', async () => {
    const emptyRegistry: IAgentToolRegistryService = {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      list: () => [],
      listReferences: () => [],
      resolve: () => undefined,
    };
    ctx = createTestAgent(agentService(IAgentToolRegistryService, emptyRegistry));
    context = ctx.get(IAgentContextMemoryService);
    shell = ctx.get(IAgentShellCommandService);

    const result = await shell.run({ command: 'echo hi' });

    expect(result.isError).toBe(true);
    expect(result.stderr).toContain('Bash tool is not registered');
    expect(context.get().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output', isError: true } },
    ]);
    expect(textOf(context.get()[1]!)).toContain('Bash tool is not registered');
  });
});
