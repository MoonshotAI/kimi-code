import { afterEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextMemoryService,
  IAgentShellCommandService,
  IAgentToolRegistryService,
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

  it('records the failure when the Bash tool is not registered', async () => {
    const emptyRegistry: IAgentToolRegistryService = {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      list: () => [],
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
