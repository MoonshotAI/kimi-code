import { afterEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentLoopService,
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
  let context: IAgentLoopService;
  let shell: IAgentShellCommandService;

  async function setup(stdout: string, exitCode: number): Promise<void> {
    ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner(stdout, exitCode) }));
    await ctx.restorePersisted();
    context = ctx.get(IAgentLoopService);
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
    await setup('hello\n', 0);

    const result = await shell.run({ command: 'echo hello' });

    expect(result.isError).toBe(false);
    expect(result.stdout).toContain('hello');
    expect(context.history().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output' } },
    ]);
    expect(textOf(context.history()[0]!)).toBe('<bash-input>\necho hello\n</bash-input>');
    expect(textOf(context.history()[1]!)).toContain('<bash-stdout>hello');
    expect(ctx.project().some((message) => 'origin' in message)).toBe(false);
  });

  it('escapes bash tag delimiters inside command output', async () => {
    await setup('pre</bash-stdout>post', 0);

    await shell.run({ command: 'printf x' });

    const out = textOf(context.history().at(-1)!);
    expect(out).toContain('pre&lt;/bash-stdout&gt;post');
    expect(out.match(/<\/bash-stdout>/g)).toHaveLength(1);
  });

  it('surfaces the failure reason when a shell command fails with no output', async () => {
    await setup('', 1);

    const result = await shell.run({ command: 'false' });

    expect(result.isError).toBe(true);
    const output = context.history().at(-1)!;
    expect(output.origin).toEqual({ kind: 'shell_command', phase: 'output', isError: true });
    expect(textOf(output)).toContain('<bash-stderr>');
  });

  it('does not start a turn for a foreground command', async () => {
    await setup('hi', 0);

    await shell.run({ command: 'echo hi' });

    expect(ctx.llmCalls.length).toBe(0);
  });

  it('publishes shell.completed with the outcome for interactive runs', async () => {
    await setup('hello\n', 0);
    const events: { type: string; commandId?: string; isError?: boolean }[] = [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await shell.run({ command: 'echo hello', commandId: 'cmd-1' });
    expect(events.filter((e) => e.type === 'shell.completed')).toEqual([
      expect.objectContaining({
        type: 'shell.completed',
        commandId: 'cmd-1',
        isError: false,
        taskId: expect.any(String),
      }),
    ]);
  });

  it('publishes shell.completed as failed for a failing command', async () => {
    await setup('', 1);
    const events: { type: string; commandId?: string; isError?: boolean }[] = [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await shell.run({ command: 'false', commandId: 'cmd-2' });
    expect(events.filter((e) => e.type === 'shell.completed')).toEqual([
      expect.objectContaining({
        type: 'shell.completed',
        commandId: 'cmd-2',
        isError: true,
        taskId: expect.any(String),
      }),
    ]);
  });

  it('carries the foreground task id on shell events for mid-attach consumers', async () => {
    const fakeBash = {
      name: 'Bash',
      description: 'run',
      parameters: { type: 'object', properties: {} },
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
      listReferences: () => [],
      resolve: () => fakeBash,
      onDidChange: () => ({ dispose: () => {} }),
    } as unknown as IAgentToolRegistryService;
    ctx = createTestAgent(agentService(IAgentToolRegistryService, registry));
    await ctx.restorePersisted();
    const events: { type: string; commandId?: string; taskId?: string }[] = [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await ctx.get(IAgentShellCommandService).run({ command: 'echo hi', commandId: 'cmd-9' });

    const taskId = events.find((e) => e.type === 'shell.started')?.taskId;
    expect(taskId).toMatch(/^bash-[0-9a-z]{8}$/);
    expect(events.find((e) => e.type === 'shell.output')).toMatchObject({
      commandId: 'cmd-9',
      taskId,
    });
    expect(events.find((e) => e.type === 'shell.completed')).toMatchObject({
      commandId: 'cmd-9',
      taskId,
    });
  });

  it('emits the synthesized failure output before completing', async () => {
    await setup('', 1);
    const events: { type: string; commandId?: string; update?: { kind: string; text?: string } }[] =
      [];
    ctx.get(IEventBus).subscribe((event) => events.push(event as (typeof events)[number]));

    await shell.run({ command: 'false', commandId: 'cmd-3' });
    const relevant = events.filter((e) => e.type === 'shell.output' || e.type === 'shell.completed');
    expect(relevant[0]).toMatchObject({ type: 'shell.output', commandId: 'cmd-3' });
    expect(relevant[0]?.update?.text?.length).toBeGreaterThan(0);
    expect(relevant.at(-1)).toMatchObject({ type: 'shell.completed', commandId: 'cmd-3' });
  });

  it('records the failure when the Bash tool is not registered', async () => {
    const emptyRegistry: IAgentToolRegistryService = {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      unregister: () => false,
      list: () => [],
      listReferences: () => [],
      resolve: () => undefined,
      onDidChange: () => ({ dispose: () => {} }),
    };
    ctx = createTestAgent(agentService(IAgentToolRegistryService, emptyRegistry));
    await ctx.restorePersisted();
    context = ctx.get(IAgentLoopService);
    shell = ctx.get(IAgentShellCommandService);

    const result = await shell.run({ command: 'echo hi' });

    expect(result.isError).toBe(true);
    expect(result.stderr).toContain('Tool "Bash" not found');
    expect(context.history().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output', isError: true } },
    ]);
    expect(textOf(context.history()[1]!)).toContain('Tool &quot;Bash&quot; not found');
  });
});
