import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { ToolCall } from '@moonshot-ai/kosong';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentPlanService, type PlanData } from '#/agent/plan';
import { IAgentPermissionRulesService } from '#/agent/permissionRules';
import { IAgentProfileService } from '#/agent/profile';
import type { ISessionAgentFileSystem } from '#/session/agentFs';
import type { ISessionProcessRunner } from '#/session/process';
import { createFakeAgentFs, createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import {
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../harness';

interface PlanFakes {
  readonly fs: ISessionAgentFileSystem;
  readonly runner: ISessionProcessRunner;
}

/**
 * Minimal fs + runner pair with sensible plan-service defaults (mkdir /
 * readText no-op, runner throws). Individual tests override the specific
 * methods they need.
 */
function createPlanFakes(overrides: Partial<ISessionAgentFileSystem> = {}): PlanFakes {
  const fs = createFakeAgentFs({
    mkdir: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
    ...overrides,
  });
  const runner = createFakeProcessRunner();
  return { fs, runner };
}

function createPlanCommandFakes(stdout: string): PlanFakes {
  return {
    fs: createPlanFakes().fs,
    runner: createCommandRunner(stdout),
  };
}

function createPlanFileFakes(
  files = new Map<string, string>(),
  overrides: Partial<ISessionAgentFileSystem> = {},
): {
  readonly files: Map<string, string>;
  readonly readText: ReturnType<typeof vi.fn>;
  readonly writeText: ReturnType<typeof vi.fn>;
  readonly fakes: PlanFakes;
} {
  const readText = vi.fn(async (path: string) => files.get(path) ?? '');
  const writeText = vi.fn(async (path: string, content: string) => {
    files.set(path, content);
  });
  return {
    files,
    readText,
    writeText,
    fakes: createPlanFakes({
      readText,
      writeText,
      ...overrides,
    }),
  };
}

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

describe('Plan service', () => {
  let activeFakes: PlanFakes;
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let injector: InjectableDynamicInjector;
  let permissionRules: IAgentPermissionRulesService;
  let plan: IAgentPlanService;
  let profile: IAgentProfileService;
  let tempDirs: string[];

  beforeEach(() => {
    activeFakes = createPlanFakes();
    tempDirs = [];
    ctx = createTestAgent(
      execEnvServices({
        agentFs: delegatingFs(),
        processRunner: delegatingRunner(),
      }),
    );
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    permissionRules = ctx.get(IAgentPermissionRulesService);
    plan = ctx.get(IAgentPlanService);
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  /**
   * A fs whose methods delegate to whichever `activeFakes.fs` is set at call
   * time. Lets a test swap fakes mid-flight by reassigning `activeFakes`.
   */
  function delegatingFs(): ISessionAgentFileSystem {
    return new Proxy(createPlanFakes().fs, {
      get(_target, prop, receiver) {
        const value = Reflect.get(activeFakes.fs, prop, receiver);
        return typeof value === 'function' ? value.bind(activeFakes.fs) : value;
      },
    }) as ISessionAgentFileSystem;
  }

  function delegatingRunner(): ISessionProcessRunner {
    return new Proxy(createPlanFakes().runner, {
      get(_target, prop, receiver) {
        const value = Reflect.get(activeFakes.runner, prop, receiver);
        return typeof value === 'function' ? value.bind(activeFakes.runner) : value;
      },
    }) as ISessionProcessRunner;
  }

  function useFakes(fakes: PlanFakes): void {
    activeFakes = fakes;
  }

  function useTools(tools: readonly string[]): void {
    profile.update({ activeToolNames: [...tools] });
    ctx.newEvents();
  }

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function planStatus(): Promise<PlanData> {
    return plan.status();
  }

  async function expectActivePlan(): Promise<NonNullable<PlanData>> {
    const status = await planStatus();
    if (status === null) throw new Error('expected active plan');
    return status;
  }

  async function expectActivePlanPath(): Promise<string> {
    return (await expectActivePlan()).path;
  }

  async function expectPlanActive(active: boolean): Promise<void> {
    expect((await planStatus()) !== null).toBe(active);
  }

  describe('manual plan entry', () => {
    it('keeps permission gating out of the PlanMode state object', () => {
      expect('beforeToolCall' in plan).toBe(false);
    });

    it('enters plan mode without starting a model turn and prepares the plan directory', async () => {
      const mkdir = vi.fn().mockResolvedValue(undefined);
      const writeText = vi.fn().mockResolvedValue(0);
      const cwd = await makeTempDir('kimi-plan-entry-');
      useFakes(createPlanFakes({ mkdir, writeText }));
      profile.update({ cwd });

      await ctx.rpc.enterPlan({});
      await delay(10);

      const status = await expectActivePlan();
      expect(status.path.startsWith(`${join(cwd, 'plan')}/`)).toBe(true);
      expect(status.path.endsWith('.md')).toBe(true);
      expect(mkdir).toHaveBeenCalledWith(join(cwd, 'plan'));
      expect(writeText).not.toHaveBeenCalled();
      expect(ctx.allEvents.some((event) => event.event === 'turn.started')).toBe(false);
      expect(ctx.llmCalls).toHaveLength(0);
    });

    it('derives the no-homedir plan path from cwd on enter and restore', async () => {
      const cwd = await makeTempDir('kimi-plan-path-');
      useFakes(createPlanFakes({
        writeText: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
      }));
      profile.update({ cwd });
      await plan.enter('stable-plan');

      const livePath = await expectActivePlanPath();
      expect(livePath).toBe(join(cwd, 'plan', 'stable-plan.md'));

      const enterRecord = ctx.allEvents.find(
        (event) => event.type === '[wire]' && event.event === 'plan_mode.enter',
      );
      expect(enterRecord?.args).toEqual({
        id: 'stable-plan',
        time: expect.any(Number),
      });

      plan.exit();
      await ctx.dispatch({
        type: 'plan_mode.enter',
        id: 'stable-plan',
      });

      expect(await expectActivePlanPath()).toBe(livePath);
    });

    it('enters plan mode through the EnterPlanMode tool and reminds the next step', async () => {
      const cwd = await makeTempDir('kimi-plan-tool-entry-');
      const { fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['EnterPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'yolo' });

      const enterPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_enter_plan',
        name: 'EnterPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will enter plan mode.' }, enterPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'Plan mode is active now.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Plan first' }] });

      await ctx.untilTurnEnd();
      await delay(10);
      await expectPlanActive(true);
      expect(ctx.llmCalls).toHaveLength(2);
      expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('Plan mode is now active');
    });
  });

  describe('plan clear', () => {
    it('empties the current plan file without leaving plan mode', async () => {
      const cwd = await makeTempDir('kimi-plan-clear-');
      const { files, writeText, fakes } = createPlanFileFakes();
      useFakes(fakes);
      profile.update({ cwd });
      await plan.enter('test-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Step 1');

      await ctx.rpc.clearPlan({});

      expect(writeText).toHaveBeenCalledWith(planPath, '');
      expect(files.get(planPath)).toBe('');
      expect(await expectActivePlanPath()).toBe(planPath);
      await expect(ctx.rpc.getPlan({})).resolves.toMatchObject({
        id: 'test-plan',
        content: '',
        path: planPath,
      });
    });
  });

  describe('plan exit tool', () => {
    it('reads the current plan file and exits plan mode directly in auto mode', async () => {
      const cwd = await makeTempDir('kimi-plan-exit-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'auto' });
      await plan.enter('test-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_plan',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      await ctx.untilTurnEnd();
      expect(
        ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
      ).toBe(false);
      await expectPlanActive(false);
      const llmInput = ctx.llmCalls[1]!;
      expect(toolResultText(llmInput.history)).toContain('Plan mode deactivated');
      expect(toolResultText(llmInput.history)).toContain('# Plan');
    });

    it('stops the turn and stays in plan mode when the user rejects the plan', async () => {
      const cwd = await makeTempDir('kimi-plan-reject-exit-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'manual' });
      await plan.enter('reject-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_reject',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'This response must not be requested.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      const approval = await ctx.takeApprovalRequest();
      approval.respond({ decision: 'rejected', selectedLabel: 'Reject' });

      await ctx.untilTurnEnd();
      await expectPlanActive(true);
      expect(ctx.llmCalls).toHaveLength(1);
      expect(toolResultText(context.get())).toContain('Plan rejected by user');
    });

    it('does not execute later tool calls in the same batch after plan rejection', async () => {
      const exec = vi.fn(() => {
        throw new Error('Bash should not execute after plan rejection');
      });
      const cwd = await makeTempDir('kimi-plan-reject-skip-tool-');
      const { files, fakes: baseFakes } = createPlanFileFakes(undefined);
      const fakes: PlanFakes = {
        fs: baseFakes.fs,
        runner: createFakeProcessRunner({ exec }),
      };
      useFakes(fakes);
      useTools(['ExitPlanMode', 'Bash']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await plan.enter('reject-and-exit-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_reject_and_exit',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      const bashCall: ToolCall = {
        type: 'function',
        id: 'call_bash_after_reject',
        name: 'Bash',
        arguments: '{"command":"touch should-not-run","timeout":60}',
      };
      ctx.mockNextResponse(
        { type: 'text', text: 'I will present the plan and then run a command.' },
        exitPlanModeCall,
        bashCall,
      );
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      const approval = await ctx.takeApprovalRequest();
      approval.respond({ decision: 'rejected', selectedLabel: 'Reject' });

      await ctx.untilTurnEnd();
      await expectPlanActive(true);
      expect(exec).not.toHaveBeenCalled();
      expect(ctx.llmCalls).toHaveLength(1);
      expect(toolResultText(context.get())).toContain('Plan rejected by user');
      expect(toolResultText(context.get())).toContain(
        'Tool skipped because a previous tool call stopped the turn.',
      );
    });

    it('refuses to exit when the current plan file is empty', async () => {
      const cwd = await makeTempDir('kimi-plan-empty-exit-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await plan.enter('empty-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '');

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_empty_plan',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse(
        { type: 'text', text: 'I will present the empty plan.' },
        exitPlanModeCall,
      );
      ctx.mockNextResponse({ type: 'text', text: 'I need to write the plan first.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show an empty plan' }] });

      await ctx.untilTurnEnd();
      await expectPlanActive(true);
      expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('No plan file found');
    });
  });

  describe('plan exit tool options', () => {
    it('keeps options for approval when an option omits the optional description', async () => {
      const cwd = await makeTempDir('kimi-plan-options-exit-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'manual' });
      await plan.enter('options-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_options',
        name: 'ExitPlanMode',
        // The second option omits `description` - valid input after the
        // schema relaxation. The approval policy must still surface both.
        arguments: JSON.stringify({
          options: [
            { label: 'Approach A', description: 'Smaller refactor.' },
            { label: 'Approach B' },
          ],
        }),
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      const approval = await ctx.takeApprovalRequest();
      const rpcArgs = (
        ctx.allEvents.find(
          (event) => event.type === '[rpc]' && event.event === 'requestApproval',
        ) as { args: { action?: string; display?: { options?: readonly unknown[] } } } | undefined
      )?.args;

      expect(rpcArgs?.action).toBe('Presenting plan and exiting plan mode');
      expect(rpcArgs?.display?.options).toHaveLength(2);

      approval.respond({ decision: 'approved', selectedLabel: 'Approach A' });
      await ctx.untilTurnEnd();
    });
  });

  describe('plan allows safe tool flow', () => {
    it.each(['Write', 'Edit'] as const)(
      'runs %s on the active plan file without approval in manual mode',
      async (toolName) => {
        const files = new Map<string, string>();
        const readText = vi.fn(async (path: string) => files.get(path) ?? '');
        const writeText = vi.fn(async (path: string, content: string): Promise<void> => {
          files.set(path, content);
        });
        useFakes(createPlanFakes({ readText, writeText }));
        const cwd = await makeTempDir('kimi-plan-write-tool-');
        useTools([toolName]);
        profile.update({ cwd });
        await plan.enter('test-plan', false);

        const planPath = await expectActivePlanPath();
        files.set(planPath, '# Plan\n\n- Draft');

        const expectedContent =
          toolName === 'Write' ? '# Plan\n\n- Inspect\n- Verify' : '# Plan\n\n- Draft\n- Verify';
        const args =
          toolName === 'Write'
            ? { path: planPath, content: expectedContent }
            : { path: planPath, old_string: '- Draft', new_string: '- Draft\n- Verify' };
        const writePlanCall: ToolCall = {
          type: 'function',
          id: `call_${toolName.toLowerCase()}_plan`,
          name: toolName,
          arguments: JSON.stringify(args),
        };

        ctx.mockNextResponse({ type: 'text', text: 'I will update the plan file.' }, writePlanCall);
        ctx.mockNextResponse({ type: 'text', text: 'Plan file updated.' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Update the plan file' }] });

        await ctx.untilTurnEnd();

        expect(files.get(planPath)).toBe(expectedContent);
        expect(writeText).toHaveBeenCalledWith(planPath, expectedContent);
        expect(
          ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
        ).toBe(false);
      },
    );

    it('keeps explicit deny rules above active plan file writes', async () => {
      const files = new Map<string, string>();
      const writeText = vi.fn(async (path: string, content: string): Promise<void> => {
        files.set(path, content);
      });
      useFakes(createPlanFakes({ writeText }));
      const cwd = await makeTempDir('kimi-plan-deny-write-');
      useTools(['Write']);
      profile.update({ cwd });
      permissionRules.addRules([
        {
          decision: 'deny',
          scope: 'user',
          pattern: 'Write',
          reason: 'blocked by test',
        },
      ]);
      await plan.enter('test-plan', false);

      const planPath = await expectActivePlanPath();
      const content = '# Plan\n\n- Inspect\n- Verify';
      const writePlanCall: ToolCall = {
        type: 'function',
        id: 'call_write_plan_with_deny',
        name: 'Write',
        arguments: JSON.stringify({ path: planPath, content }),
      };

      ctx.mockNextResponse({ type: 'text', text: 'I will update the plan file.' }, writePlanCall);
      ctx.mockNextResponse({ type: 'text', text: 'Plan file updated.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Update the plan file' }] });

      await ctx.untilTurnEnd();

      expect(files.get(planPath)).toBeUndefined();
      expect(writeText).not.toHaveBeenCalled();
      expect(toolResultText(context.get())).toContain(
        'Tool "Write" was denied by permission rule. Reason: blocked by test',
      );
      expect(
        ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
      ).toBe(false);
    });

    it('allows read-only Bash to continue through permission and execution', async () => {
      const bashCall: ToolCall = {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: '{"command":"printf plan-safe","timeout":60}',
      };
      useFakes(createPlanCommandFakes('plan-safe'));
      useTools(['Bash']);
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await plan.enter('test-plan', false);

      ctx.mockNextResponse({ type: 'text', text: 'I will inspect safely.' }, bashCall);
      ctx.mockNextResponse({ type: 'text', text: 'The safe command printed plan-safe.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Inspect without mutating files' }] });

      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] permission.set_mode     { "mode": "yolo", "time": "<time>" }
        [emit] agent.status.updated    { "permission": "yolo" }
        [wire] plan_mode.enter         { "id": "test-plan", "time": "<time>" }
        [emit] agent.status.updated    { "planMode": true }
        [wire] context.splice          { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
        [wire] turn.launch             { "turnId": 0, "origin": { "kind": "user" }, "promptMessageId": "<msg-1>", "time": "<time>" }
        [emit] turn.started            { "turnId": 0, "origin": { "kind": "user" }, "promptMessageId": "<msg-1>" }
        [wire] context.splice          { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" }, "id": "<msg-2>" } ], "time": "<time>" }
        [emit] turn.step.started       { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] assistant.delta         { "turnId": 0, "delta": "I will inspect safely." }
        [emit] tool.call.delta         { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" }
        [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 530, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 530, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 530, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 530, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice          { "start": 2, "deleteCount": 0, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will inspect safely." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context.splice          { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will inspect safely." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" } ] } ], "time": "<time>" }
        [wire] context_size.measured   { "length": 3, "tokens": 553, "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 553 }
        [emit] tool.call.started       { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }
        [emit] tool.progress           { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "plan-safe" } }
        [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "plan-safe" } ], "toolCalls": [], "toolCallId": "call_bash", "id": "<msg-4>" } ], "time": "<time>" }
        [emit] tool.result             { "turnId": 0, "toolCallId": "call_bash", "output": "plan-safe" }
        [wire] context.splice          { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will inspect safely." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" } ], "providerMessageId": "mock-1" } ], "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 0 }
        [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 530, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
        [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
        [emit] assistant.delta         { "turnId": 0, "delta": "The safe command printed plan-safe." }
        [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 557, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 1087, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1087, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1087, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice          { "start": 4, "deleteCount": 0, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The safe command printed plan-safe." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context_size.measured   { "length": 5, "tokens": 569, "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 569 }
        [wire] context.splice          { "start": 4, "deleteCount": 1, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The safe command printed plan-safe." } ], "toolCalls": [], "providerMessageId": "mock-2" } ], "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 0 }
        [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 557, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
        [emit] turn.ended              { "turnId": 0, "reason": "completed" }
      `);

      expect(ctx.llmCalls).toHaveLength(2);
      expect(toolResultText(context.get())).toContain('plan-safe');
      await expectPlanActive(true);
      expect(
        ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
      ).toBe(false);
    });
  });

  describe('plan mode Bash ordinary permission behavior', () => {
    it('allows Bash through ordinary yolo permission behavior', async () => {
      const bashCall: ToolCall = {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: '{"command":"rm forbidden.txt","timeout":60}',
      };
      useFakes(createPlanCommandFakes('removed'));
      useTools(['Bash']);
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await plan.enter('test-plan', false);

      ctx.mockNextResponse({ type: 'text', text: 'I will mutate a file.' }, bashCall);
      ctx.mockNextResponse({ type: 'text', text: 'The command completed.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Remove forbidden.txt' }] });

      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] permission.set_mode     { "mode": "yolo", "time": "<time>" }
        [emit] agent.status.updated    { "permission": "yolo" }
        [wire] plan_mode.enter         { "id": "test-plan", "time": "<time>" }
        [emit] agent.status.updated    { "planMode": true }
        [wire] context.splice          { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
        [wire] turn.launch             { "turnId": 0, "origin": { "kind": "user" }, "promptMessageId": "<msg-1>", "time": "<time>" }
        [emit] turn.started            { "turnId": 0, "origin": { "kind": "user" }, "promptMessageId": "<msg-1>" }
        [wire] context.splice          { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" }, "id": "<msg-2>" } ], "time": "<time>" }
        [emit] turn.step.started       { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] assistant.delta         { "turnId": 0, "delta": "I will mutate a file." }
        [emit] tool.call.delta         { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" }
        [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 527, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 527, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 527, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 527, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice          { "start": 2, "deleteCount": 0, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will mutate a file." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context.splice          { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will mutate a file." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" } ] } ], "time": "<time>" }
        [wire] context_size.measured   { "length": 3, "tokens": 550, "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 550 }
        [emit] tool.call.started       { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }
        [emit] tool.progress           { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "removed" } }
        [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "removed" } ], "toolCalls": [], "toolCallId": "call_bash", "id": "<msg-4>" } ], "time": "<time>" }
        [emit] tool.result             { "turnId": 0, "toolCallId": "call_bash", "output": "removed" }
        [wire] context.splice          { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will mutate a file." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" } ], "providerMessageId": "mock-1" } ], "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 0 }
        [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 527, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
        [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
        [emit] assistant.delta         { "turnId": 0, "delta": "The command completed." }
        [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 553, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 1080, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1080, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1080, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice          { "start": 4, "deleteCount": 0, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The command completed." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context_size.measured   { "length": 5, "tokens": 562, "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 562 }
        [wire] context.splice          { "start": 4, "deleteCount": 1, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The command completed." } ], "toolCalls": [], "providerMessageId": "mock-2" } ], "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 0 }
        [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 553, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
        [emit] turn.ended              { "turnId": 0, "reason": "completed" }
      `);
      expect(toolResultText(context.get())).toContain('removed');
    });
  });

  describe('plan mode injection cadence', () => {
    it('dedupes immediate repeats and emits sparse reminders after assistant turns', async () => {
      await plan.enter('test-plan', false);

      await injectDynamic();
      const afterFull = context.get().length;
      expect(lastUserText(context.get())).toContain('Plan mode is active');
      expect(lastUserText(context.get())).toContain('Plan file:');

      await injectDynamic();
      expect(context.get()).toHaveLength(afterFull);

      ctx.appendAssistantTurn(1, 'assistant one');
      ctx.appendAssistantTurn(2, 'assistant two');
      await injectDynamic();

      expect(lastUserText(context.get())).toContain('Plan mode still active');
      expect(lastUserText(context.get())).toContain('Plan file:');
    });

    it('emits a reentry reminder when restored plan mode already has plan content', async () => {
      useFakes(createPlanFakes({
        readText: vi.fn(async () => '# Existing Plan\n\n- Keep this context'),
      }));
      await ctx.dispatch({
        type: 'plan_mode.enter',
        id: 'restored-plan',
      });

      await injectDynamic();

      expect(lastUserText(context.get())).toContain('Re-entering Plan Mode');
      expect(lastUserText(context.get())).toContain('Read the existing plan file');
    });

    it('emits one exit reminder after leaving plan mode', async () => {
      await plan.enter('test-plan', false);
      await injectDynamic();

      plan.exit();
      await injectDynamic();
      const afterExit = context.get().length;
      expect(lastUserText(context.get())).toContain('Plan mode is no longer active');

      await injectDynamic();
      expect(context.get()).toHaveLength(afterExit);
    });

    it('keeps the preserved injection index aligned after undo removes earlier messages', async () => {
      await plan.enter('test-plan', false);

      ctx.appendUserMessage([{ type: 'text', text: 'draft the plan' }]);
      await injectDynamic();
      ctx.appendAssistantTurn(1, 'Plan drafted.');

      ctx.undoHistory(1);
      ctx.appendUserMessage([{ type: 'text', text: 'new plan request' }]);
      await injectDynamic();

      expect(lastUserText(context.get())).toContain('Plan mode is active');
    });
  });

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function injectDynamic(): Promise<void> {
    await injector.inject();
  }
});

function lastUserText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  const message = history.findLast((item) => item.role === 'user');
  if (message === undefined) return '';
  return message.content
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

function toolResultText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  return history
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content)
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n');
}
