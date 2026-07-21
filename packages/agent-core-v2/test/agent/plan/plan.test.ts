import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { ToolCall } from '#/kosong/contract/message';
import { dirname, isAbsolute, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPlanService, type PlanData } from '#/agent/plan/plan';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionProcessRunner } from '#/session/process/processRunner';
import { createFakeHostFs, createFakeProcessRunner } from '../../tools/fixtures/fake-exec';
import {
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../harness';

interface PlanFakes {
  readonly fs: IHostFileSystem;
  readonly runner: ISessionProcessRunner;
}

function createPlanFakes(overrides: Partial<IHostFileSystem> = {}): PlanFakes {
  const fs = createFakeHostFs({
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
  overrides: Partial<IHostFileSystem> = {},
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
        hostFs: delegatingFs(),
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

  function delegatingFs(): IHostFileSystem {
    return new Proxy(createPlanFakes().fs, {
      get(_target, prop, receiver) {
        const value = Reflect.get(activeFakes.fs, prop, receiver);
        return typeof value === 'function' ? value.bind(activeFakes.fs) : value;
      },
    }) as IHostFileSystem;
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

  function expectedPlanPath(id: string): string {
    const session = ctx.get(ISessionContext);
    const agent = ctx.get(IAgentScopeContext);
    return join(session.sessionDir, 'agents', agent.agentId, 'plans', `${id}.md`);
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
      const expectedPath = expectedPlanPath(status.id);
      expect(status.path).toBe(expectedPath);
      expect(mkdir).toHaveBeenCalledWith(dirname(expectedPath), { recursive: true });
      expect(writeText).not.toHaveBeenCalled();
      expect(ctx.allEvents.some((event) => event.event === 'turn.started')).toBe(false);
      expect(ctx.llmCalls).toHaveLength(0);
    });

    it('derives the plan path from the agent homedir on enter and restore', async () => {
      const cwd = await makeTempDir('kimi-plan-path-');
      useFakes(createPlanFakes({
        writeText: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
      }));
      profile.update({ cwd });
      await plan.enter('stable-plan');

      const livePath = await expectActivePlanPath();
      expect(livePath).toBe(expectedPlanPath('stable-plan'));

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

    it('keeps the plan path under the agent homedir when the profile cwd is empty', async () => {
      useFakes(createPlanFakes({
        writeText: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
      }));
      profile.update({ cwd: '' });

      await plan.enter('homedir-plan');

      const planPath = await expectActivePlanPath();
      expect(isAbsolute(planPath)).toBe(true);
      expect(planPath).toBe(expectedPlanPath('homedir-plan'));
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

  describe('plan revisions', () => {
    function revisionRecords(): Record<string, unknown>[] {
      return ctx.allEvents
        .filter((event) => event.type === '[wire]' && event.event === 'plan.revision')
        .map((event) => event.args as Record<string, unknown>);
    }

    function revisionPath(id: string, version: number): string {
      const agent = ctx.get(IAgentScopeContext);
      return `${agent.scope()}/plan/${id}/v${version}.md`;
    }

    async function readRevisionBlob(id: string, version: number): Promise<string | undefined> {
      const blobs = ctx.get(IBlobStore);
      const agent = ctx.get(IAgentScopeContext);
      const data = await blobs.get(agent.scope(), `plan/${id}/v${version}.md`);
      return data === undefined ? undefined : Buffer.from(data).toString('utf8');
    }

    it('is a no-op while plan mode is inactive', async () => {
      await plan.recordRevision();
      expect(revisionRecords()).toEqual([]);
    });

    it('snapshots the current plan file into a versioned blob with a reference record', async () => {
      const cwd = await makeTempDir('kimi-plan-revision-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      profile.update({ cwd });
      await plan.enter('rev-plan', false);

      const planPath = await expectActivePlanPath();
      const content = '# Plan\n\n- Inspect\n- Verify';
      files.set(planPath, content);

      await plan.recordRevision();

      expect(await readRevisionBlob('rev-plan', 1)).toBe(content);
      expect(revisionRecords()).toEqual([
        {
          id: 'rev-plan',
          version: 1,
          path: revisionPath('rev-plan', 1),
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
          bytes: Buffer.byteLength(content),
          time: expect.any(Number),
        },
      ]);
    });

    it('increments the version on every recording and keeps earlier blobs', async () => {
      const cwd = await makeTempDir('kimi-plan-revision-twice-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      profile.update({ cwd });
      await plan.enter('rev-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Draft');
      await plan.recordRevision();
      files.set(planPath, '# Plan\n\n- Final');
      await plan.recordRevision();

      expect(revisionRecords().map((record) => record['version'])).toEqual([1, 2]);
      expect(await readRevisionBlob('rev-plan', 1)).toBe('# Plan\n\n- Draft');
      expect(await readRevisionBlob('rev-plan', 2)).toBe('# Plan\n\n- Final');
    });

    it('mints the next version from the replayed counter', async () => {
      const cwd = await makeTempDir('kimi-plan-revision-restore-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      profile.update({ cwd });
      await plan.enter('rev-plan', false);

      const planPath = await expectActivePlanPath();
      const content = '# Plan\n\n- After restore';
      files.set(planPath, content);

      // Simulate a restored v1 fact: replay applies the record to the model
      // without re-recording a snapshot entry.
      await ctx.dispatch({
        type: 'plan.revision',
        id: 'rev-plan',
        version: 1,
        path: revisionPath('rev-plan', 1),
        sha256: 'restored-sha',
        bytes: 5,
      });

      await plan.recordRevision();

      expect(revisionRecords().map((record) => record['version'])).toEqual([2]);
      expect(await readRevisionBlob('rev-plan', 2)).toBe(content);
    });

    it('records a revision when ExitPlanMode submits the plan', async () => {
      const cwd = await makeTempDir('kimi-plan-submit-revision-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'auto' });
      await plan.enter('submit-plan', false);

      const planPath = await expectActivePlanPath();
      const content = '# Plan\n\n- Inspect\n- Change\n- Verify';
      files.set(planPath, content);

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_revision',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      await ctx.untilTurnEnd();
      await expectPlanActive(false);
      expect(revisionRecords().map((record) => record['version'])).toEqual([1]);
      expect(await readRevisionBlob('submit-plan', 1)).toBe(content);
    });

    it('records the next version when a revised plan is resubmitted', async () => {
      const cwd = await makeTempDir('kimi-plan-revise-revision-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      profile.update({ cwd });
      await ctx.rpc.setPermission({ mode: 'manual' });
      await plan.enter('revise-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Draft');

      const firstCall: ToolCall = {
        type: 'function',
        id: 'call_exit_first',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      const secondCall: ToolCall = {
        type: 'function',
        id: 'call_exit_second',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, firstCall);
      ctx.mockNextResponse({ type: 'text', text: 'I tightened the plan.' }, secondCall);
      ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      const first = await ctx.takeApprovalRequest();
      first.respond({ decision: 'rejected', selectedLabel: 'Revise', feedback: 'Tighten it.' });
      // Set synchronously so the resubmission resolves against the revision.
      files.set(planPath, '# Plan\n\n- Tightened');

      const second = await ctx.takeApprovalRequest();
      second.respond({ decision: 'approved' });

      await ctx.untilTurnEnd();
      await expectPlanActive(false);
      expect(revisionRecords().map((record) => record['version'])).toEqual([1, 2]);
      expect(await readRevisionBlob('revise-plan', 1)).toBe('# Plan\n\n- Draft');
      expect(await readRevisionBlob('revise-plan', 2)).toBe('# Plan\n\n- Tightened');
    });

    it('does not record a revision on clear or on plan file writes', async () => {
      const cwd = await makeTempDir('kimi-plan-no-revision-');
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      profile.update({ cwd });
      await plan.enter('quiet-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Step 1');

      await plan.clear();
      files.set(planPath, '# Plan\n\n- Step 2');

      expect(revisionRecords()).toEqual([]);
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

    it('short-circuits active plan file writes ahead of explicit deny rules', async () => {
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

      // The plan-guard hook lets plan-file writes through before the
      // permission chain runs, so user-configured deny rules no longer
      // adjudicate them.
      expect(files.get(planPath)).toBe(content);
      expect(writeText).toHaveBeenCalledWith(planPath, content);
      expect(toolResultText(context.get())).not.toContain('denied by permission rule');
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
        [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
        [wire] plan_mode.enter             { "id": "test-plan", "time": "<time>" }
        [emit] agent.status.updated        { "planMode": true }
        [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Inspect without mutating files" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.spliced             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
        [emit] context.spliced             { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
        [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "turnId": 0, "delta": "I will inspect safely." }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "contextTokens": 588 }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will inspect safely." } }, "time": "<time>" }
        [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_bash", "name": "Bash", "since": "<time>" } ], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 } }, "time": "<time>" }
        [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "plan-safe" } }
        [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "plan-safe" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_bash", "result": { "output": "plan-safe" } }, "time": "<time>" }
        [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "turnId": 0, "delta": "The safe command printed plan-safe." }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 592, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 1157, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1157, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1157, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "contextTokens": 604 }
        [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 592, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The safe command printed plan-safe." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 592, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
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
        [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
        [wire] plan_mode.enter             { "id": "test-plan", "time": "<time>" }
        [emit] agent.status.updated        { "planMode": true }
        [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Remove forbidden.txt" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.spliced             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
        [emit] context.spliced             { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
        [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "turnId": 0, "delta": "I will mutate a file." }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "contextTokens": 585 }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will mutate a file." } }, "time": "<time>" }
        [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_bash", "name": "Bash", "since": "<time>" } ], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 } }, "time": "<time>" }
        [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "removed" } }
        [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "removed" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_bash", "result": { "output": "removed" } }, "time": "<time>" }
        [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "turnId": 0, "delta": "The command completed." }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 588, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 1150, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1150, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1150, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "contextTokens": 597 }
        [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 588, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The command completed." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 588, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
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
