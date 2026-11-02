import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { ToolCall } from '#human/message';
import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { IAgentPlanService, type PlanData } from '#/features/plan/plan';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { createFakeHostFs, createFakeProcessRunner } from '../../tools/fixtures/fake-exec';
import { createMapFs, stubPlanEnvironment } from './stubs';
import {
  agentService,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../harness';

interface PlanFakes {
  readonly fs: IHostFileSystem;
  readonly runner: IHostProcessService;
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

describe('Plan service', () => {
  let activeFakes: PlanFakes;
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let permissionRules: IAgentPermissionRulesService;
  let plan: IAgentPlanService;
  let profile: IAgentProfileService;
  let tempDirs: string[];

  beforeEach(async () => {
    activeFakes = createPlanFakes();
    tempDirs = [];
    ctx = createTestAgent(
      execEnvServices({
        hostFs: delegatingFs(),
        processRunner: delegatingRunner(),
      }),
    );
    context = ctx.get(IAgentContextMemoryService);
    permissionRules = ctx.get(IAgentPermissionRulesService);
    plan = ctx.get(IAgentPlanService);
    profile = ctx.get(IAgentProfileService);
    await ctx.restorePersisted();
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

  function delegatingRunner(): IHostProcessService {
    return new Proxy(createPlanFakes().runner, {
      get(_target, prop, receiver) {
        const value = Reflect.get(activeFakes.runner, prop, receiver);
        return typeof value === 'function' ? value.bind(activeFakes.runner) : value;
      },
    }) as IHostProcessService;
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
    const path = (await expectActivePlan()).path;
    if (path === null) throw new Error('expected plan file path');
    return path;
  }

  function expectedPlanPath(id: string): string {
    const agent = ctx.get(IAgentScopeContext);
    return join(ctx.get(ISessionContext).sessionDir, 'agents', agent.agentId, 'plans', `${id}.md`);
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
      useFakes(createPlanFakes({ mkdir, writeText }));

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

    it('restores plan content from the persistent path written by previous versions', async () => {
      const session = ctx.get(ISessionContext);
      const path = join(session.sessionDir, 'agents', ctx.get(IAgentScopeContext).agentId, 'plans', 'existing-plan.md');
      const content = '# Existing plan\n\n- Keep the saved work';
      const { fakes } = createPlanFileFakes(new Map([[path, content]]));
      useFakes(fakes);

      await ctx.dispatch({ type: 'plan_mode.enter', id: 'existing-plan' });

      expect(await plan.status()).toEqual({ id: 'existing-plan', path, content });
    });

    it('keeps the local persistent plan path on enter and restore', async () => {
      useFakes(createPlanFakes({
        writeText: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
      }));
      await plan.enter('stable-plan');

      const livePath = await expectActivePlanPath();
      expect(livePath).toBe(expectedPlanPath('stable-plan'));

      const enterRecord = ctx.allEvents.find(
        (event) => event.type === '[wire]' && event.event === 'plan_mode.enter',
      );
      expect(enterRecord?.args).toEqual({
        agentId: 'main',
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

    it('keeps plan mode off when the model calls EnterPlanMode', async () => {
      const { fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      await ctx.rpc.setPermission({ mode: 'yolo' });

      const enterPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_enter_plan',
        name: 'EnterPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will enter plan mode.' }, enterPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'Turn on plan mode with Shift-Tab or /plan.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Plan first' }] });

      await ctx.untilTurnEnd();
      await delay(10);
      await expectPlanActive(false);
      expect(ctx.llmCalls).toHaveLength(2);
      expect(ctx.llmCalls[0]!.tools.map((tool) => tool.name)).not.toContain('EnterPlanMode');
      expect(toolResultText(ctx.llmCalls[1]!.history)).not.toContain('Plan mode is now active');
    });
  });

  describe('remote environment binding', () => {
    const remoteTempDir = '/remote/tmp';
    let remoteCtx: TestAgentContext;
    let remotePlan: IAgentPlanService;
    let localFiles: Map<string, string>;
    let remoteFiles: Map<string, string>;
    let remoteMkdir: Mock<IHostFileSystem['mkdir']>;

    beforeEach(async () => {
      localFiles = new Map();
      remoteFiles = new Map();
      remoteMkdir = vi.fn<IHostFileSystem['mkdir']>().mockResolvedValue(undefined);
      remoteCtx = createTestAgent([
        execEnvServices({ hostFs: createMapFs(localFiles) }),
        agentService(
          IAgentEnvironmentService,
          stubPlanEnvironment({
            fs: createMapFs(remoteFiles, { mkdir: remoteMkdir }),
            tempDir: remoteTempDir,
          }),
        ),
      ]);
      remotePlan = remoteCtx.get(IAgentPlanService);
      await remoteCtx.restorePersisted();
    });

    afterEach(async () => {
      await remoteCtx.dispose();
    });

    function useRemoteTools(tools: readonly string[]): void {
      remoteCtx.get(IAgentProfileService).update({ activeToolNames: [...tools] });
      remoteCtx.newEvents();
    }

    it('keeps denying writes to non-plan files on a remote binding', async () => {
      useRemoteTools(['Write']);
      await remotePlan.enter('remote-plan', false);

      const otherPath = '/remote/work/src/main.ts';
      const writeCall: ToolCall = {
        type: 'function',
        id: 'call_write_other',
        name: 'Write',
        arguments: JSON.stringify({ path: otherPath, content: 'nope' }),
      };
      remoteCtx.mockNextResponse({ type: 'text', text: 'I will edit the source.' }, writeCall);
      remoteCtx.mockNextResponse({ type: 'text', text: 'Understood.' });
      await remoteCtx.rpc.prompt({ input: [{ type: 'text', text: 'Edit the source file' }] });

      await remoteCtx.untilTurnEnd();

      expect(remoteFiles.has(otherPath)).toBe(false);
      expect(toolResultText(remoteCtx.llmCalls[1]!.history)).toContain('Plan mode is active');
    });
  });

  describe('plan clear', () => {
    it('empties the current plan file without leaving plan mode', async () => {
      const { files, writeText, fakes } = createPlanFileFakes();
      useFakes(fakes);
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

    function revisionKey(id: string, version: number): string {
      return `plan/${id}/v${version}.md`;
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
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      await plan.enter('rev-plan', false);

      const planPath = await expectActivePlanPath();
      const content = '# Plan\n\n- Inspect\n- Verify';
      files.set(planPath, content);

      await plan.recordRevision();

      expect(await readRevisionBlob('rev-plan', 1)).toBe(content);
      expect(revisionRecords()).toEqual([
        {
          agentId: 'main',
          id: 'rev-plan',
          version: 1,
          key: revisionKey('rev-plan', 1),
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
          bytes: Buffer.byteLength(content),
          time: expect.any(Number),
        },
      ]);
    });

    it('increments the version on every recording and keeps earlier blobs', async () => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
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
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      await plan.enter('rev-plan', false);

      const planPath = await expectActivePlanPath();
      const content = '# Plan\n\n- After restore';
      files.set(planPath, content);

      await ctx.dispatch({
        type: 'plan.revision',
        id: 'rev-plan',
        version: 1,
        key: revisionKey('rev-plan', 1),
        sha256: 'restored-sha',
        bytes: 5,
      });

      await plan.recordRevision();

      expect(revisionRecords().map((record) => record['version'])).toEqual([2]);
      expect(await readRevisionBlob('rev-plan', 2)).toBe(content);
    });

    it('records a revision when ExitPlanMode submits the plan', async () => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
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

      const approval = await ctx.takeApprovalRequest();
      approval.respond({ decision: 'approved' });

      await ctx.untilTurnEnd();
      await expectPlanActive(false);
      expect(revisionRecords().map((record) => record['version'])).toEqual([1]);
      expect(await readRevisionBlob('submit-plan', 1)).toBe(content);
    });

    it('records the next version when a revised plan is resubmitted', async () => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
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
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      await plan.enter('quiet-plan', false);

      const planPath = await expectActivePlanPath();
      files.set(planPath, '# Plan\n\n- Step 1');

      await plan.clear();
      files.set(planPath, '# Plan\n\n- Step 2');

      expect(revisionRecords()).toEqual([]);
    });
  });

  describe('plan exit tool', () => {
    it('asks the user to review the plan in auto mode before exiting plan mode', async () => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
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

      const approval = await ctx.takeApprovalRequest();
      await expectPlanActive(true);
      approval.respond({ decision: 'approved' });

      await ctx.untilTurnEnd();
      await expectPlanActive(false);
      const llmInput = ctx.llmCalls[1]!;
      expect(toolResultText(llmInput.history)).toContain('Plan mode deactivated');
      expect(toolResultText(llmInput.history)).toContain('## Approved Plan:\n# Plan');
      expect(toolResultText(llmInput.history)).not.toContain('auto-approved');
    });

    it.each([
      ['in yolo mode', 'yolo', false],
      ['with an allow rule in auto mode', 'auto', true],
      ['with an allow rule in manual mode', 'manual', true],
    ] as const)('asks the user to review the plan %s', async (_condition, mode, allowRule) => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      if (allowRule) {
        permissionRules.addRules([{ decision: 'allow', scope: 'user', pattern: 'ExitPlanMode' }]);
      }
      await ctx.rpc.setPermission({ mode });
      await plan.enter('test-plan', false);
      files.set(await expectActivePlanPath(), '# Plan\n\n- Inspect');

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_plan',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

      const approval = await ctx.takeApprovalRequest();
      await expectPlanActive(true);
      approval.respond({ decision: 'approved' });

      await ctx.untilTurnEnd();
      await expectPlanActive(false);
    });

    it('asks again for the next plan after the user approved one for the whole session', async () => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
      await ctx.rpc.setPermission({ mode: 'auto' });

      for (const id of ['first-plan', 'second-plan']) {
        await plan.enter(id, false);
        files.set(await expectActivePlanPath(), `# Plan ${id}`);
        const exitPlanModeCall: ToolCall = {
          type: 'function',
          id: `call_exit_${id}`,
          name: 'ExitPlanMode',
          arguments: '{}',
        };
        ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
        ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: `Show ${id}` }] });

        const approval = await ctx.takeApprovalRequest();
        await expectPlanActive(true);
        approval.respond({ decision: 'approved', scope: 'session' });

        await ctx.untilTurnEnd();
        await expectPlanActive(false);
      }
    });

    it('stops the turn and stays in plan mode when the user rejects the plan', async () => {
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
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
      const { files, fakes: baseFakes } = createPlanFileFakes(undefined);
      const fakes: PlanFakes = {
        fs: baseFakes.fs,
        runner: createFakeProcessRunner({ spawn: exec }),
      };
      useFakes(fakes);
      useTools(['ExitPlanMode', 'Bash']);
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
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
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
      const { files, fakes } = createPlanFileFakes();
      useFakes(fakes);
      useTools(['ExitPlanMode']);
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
        useTools([toolName]);
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
      useTools(['Write']);
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
        [wire] permission.set_mode         { "agentId": "main", "mode": "yolo", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "permission": "yolo" }
        [wire] plan_mode.enter             { "agentId": "main", "id": "test-plan", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "planMode": true }
        [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "createdAt": "<time>" }
        [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
        [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Inspect without mutating files" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.started          { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
        [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "origin": { "kind": "injection", "variant": "plan_mode" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] tool_select.initialized     { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task in its own context.\\n\\nDo not launch a subagent unless the user explicitly asks for one, including delegation, parallel agents, or a named agent type. Explicit instructions in AGENTS.md or a skill, and user-enabled multi-agent modes, also authorize launching. Large or multi-part tasks and requests for depth, thoroughness, research, or investigation do not; do that work yourself. Agent type descriptions below guide selection only after authorization. Resuming already-authorized work needs no new request. Each subagent starts cold and re-derives context, costing time and tokens.\\n\\nWriting the prompt:\\n- Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups: put exact paths or commands you already know in the prompt.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nBackground agent execution is disabled for this agent. Do not set \`run_in_background=true\` — any call that sets it is rejected before the subagent launches. Run every subagent in the foreground and wait for its result.\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, Glob, Grep, Read, Skill, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- Group related questions into one call to minimize interruptions\\n- List a recommended option first\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nEach call runs in a fresh shell: variables and \`cd\` do not persist, so pass \`cwd\` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with \`Command failed with exit code: N\`. Do not run interactive commands or commands that never exit. Set \`timeout\` for possibly long-running commands. A command that hits its timeout is killed.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n- Use \`&&\` for commands that depend on each other. Issue independent read-only commands (separate \`git show\`, \`ls\`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with \`echo\` separators.\\n- Avoid \`..\` paths outside the working directory, and do not modify files outside it unless explicitly instructed.\\n- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n- Command availability depends on the host; run \`which <command>\` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the \`gh\` CLI when installed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable goal that the runtime pursues across multiple turns. Call it only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one. Do not create a goal for greetings, ordinary questions, or requests without a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion first; if they clearly insist after you warn them that the wording is vague or risky, create the goal anyway. Include \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise and reference long task descriptions by file path. Creating fails if a goal already exists; pass \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued later in this session, recurring or once.\\n\\nWhen the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: \\"around 9\\" → \`57 8 * * *\`, \\"hourly\\" → \`7 * * * *\`.\\n\\nTasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with \`coalescedCount\` > 1: act on the latest state once. The final fire carries \`stale=\\"true\\"\`, so call CronCreate again with the same \`cron\` and \`prompt\` if the schedule is still wanted.\\n\\nUsers cannot manage cron tasks themselves: after creating one, tell the user its \`id\` and that they can ask you to cancel or change it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a live cron task by its \`id\`. Fired one-shots and expired tasks are already gone; if an id is not found, call CronList instead of retrying it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List this session's cron tasks. Read-only. \`stale: true\` marks a recurring task whose next fire is its last. After a context compaction, call this instead of guessing ids.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash \`sed\`.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.\\n\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, budgets with what remains of each, and the terminal reason once it has stopped. Returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — recursive from the search root; \`src/*.ts\` — only directly inside \`src/\`\\n- \`src/**/*.ts\` — recursive beneath \`src/\`\\n- \`*.{ts,tsx}\` and \`{src,test}/**/*.ts\` — brace expansion\\n\\nFollow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.\\n\\nAvoid broad searches in dependency or build-output directories, especially with \`include_ignored\`; prefer a narrow \`path\` or \`pattern\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files are searched by default.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Read", "description": "Read a UTF-8 or UTF-16 text file from the active environment's filesystem, or a \`kimi-file://\` attachment of this session.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Output is \`<line-number>\\\\t<content>\` per line. A \`<system>\` status block may follow; it is not part of the file.\\n- Results are bounded by \`max_chars\`: 100000 by default, up to 100000.\\n- If the status block reports an incomplete range, continue with its \`Next Read\` arguments exactly. Do not answer from a partial page when the task requires the remaining content.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -9007199254740991, "exclusiveMaximum": 0 } ] }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ReadMediaFile", "description": "Read media content from a file.\\n\\nAny reported local attachment path belongs to the server; external converters must be able to access that filesystem.\\n\\n- Read multiple files in parallel when possible.\\n- After generating or editing media via commands or scripts, read the result back before continuing.\\n- Maximum size: 100MB.\\n\\n**Capabilities**\\n\\n- This tool supports image and video files.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to an image or video file, or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories and text files are not supported." }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load one or more tools by name so you can call them. The loadable names are listed in the <tools_added>/<tools_removed> announcements in the system context — fold them in order to get the current list. If you have not seen a <tools_added> announcement in this session, no tools are currently loadable — do not call select_tools. Pass the exact tool name(s) you need — plugin, skill, or category names do not work. The full definitions become available immediately, so you can call them directly in your next tool call. Only announced names are loadable — tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "minItems": 1, "type": "array", "items": { "type": "string" }, "description": "Exact tool names to load, taken from the latest announced tool list." } }, "required": [ "names" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget for the current goal, only when the user clearly states one, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not set one for vague wording such as \\"spend some time\\" or \\"try to be quick\\". Convert a compound time to one unit first: \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status, including task IDs for \`TaskOutput\`.\\n\\nAfter context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With \`active_only=false\`, \`lost\` tasks from previous processes may appear; treat them as terminated.\\n\\nThis tool is read-only and safe in plan mode; it does not return task output.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a non-blocking snapshot of a running or completed background task.\\n\\nUse after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. \`active\` resumes a paused or blocked goal when the user explicitly asks you to work on it again. \`complete\` and \`blocked\` end autonomous work: while a goal is active, its full reminder states exactly when each one is warranted; later reminders keep the current goal state and point back to those rules. Follow them, and do not call this tool merely because you finished a slice of work. After \`complete\` or \`blocked\`, write the completion summary or the blocker explanation in your next message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Use Write only for new files, complete replacements, or content with little continuity; use Edit for every incremental change to an existing file.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
        [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Bash" ], "time": "<time>" }
        [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will inspect safely." }
        [emit] tool.call.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "agentId": "main", "length": 3, "tokens": 789, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 789 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will inspect safely." } }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
        [emit] tool.progress               { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "plan-safe" } }
        [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "output": "plan-safe" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_bash", "result": { "output": "plan-safe" } }, "time": "<time>" }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The safe command printed plan-safe." }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 799, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 1565, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1565, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1565, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "agentId": "main", "length": 5, "tokens": 811, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 811 }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 799, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The safe command printed plan-safe." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 799, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "I will inspect safely." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" } ] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "tool", "content": [ { "type": "text", "text": "plan-safe" } ], "toolCallId": "call_bash" }, "meta": { "source": "tool" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "The safe command printed plan-safe." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 799, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-2" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
        [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
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
        [wire] permission.set_mode         { "agentId": "main", "mode": "yolo", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "permission": "yolo" }
        [wire] plan_mode.enter             { "agentId": "main", "id": "test-plan", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "planMode": true }
        [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "createdAt": "<time>" }
        [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
        [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Remove forbidden.txt" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.started          { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
        [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "origin": { "kind": "injection", "variant": "plan_mode" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] tool_select.initialized     { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task in its own context.\\n\\nDo not launch a subagent unless the user explicitly asks for one, including delegation, parallel agents, or a named agent type. Explicit instructions in AGENTS.md or a skill, and user-enabled multi-agent modes, also authorize launching. Large or multi-part tasks and requests for depth, thoroughness, research, or investigation do not; do that work yourself. Agent type descriptions below guide selection only after authorization. Resuming already-authorized work needs no new request. Each subagent starts cold and re-derives context, costing time and tokens.\\n\\nWriting the prompt:\\n- Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups: put exact paths or commands you already know in the prompt.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nBackground agent execution is disabled for this agent. Do not set \`run_in_background=true\` — any call that sets it is rejected before the subagent launches. Run every subagent in the foreground and wait for its result.\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, Glob, Grep, Read, Skill, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- Group related questions into one call to minimize interruptions\\n- List a recommended option first\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nEach call runs in a fresh shell: variables and \`cd\` do not persist, so pass \`cwd\` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with \`Command failed with exit code: N\`. Do not run interactive commands or commands that never exit. Set \`timeout\` for possibly long-running commands. A command that hits its timeout is killed.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n- Use \`&&\` for commands that depend on each other. Issue independent read-only commands (separate \`git show\`, \`ls\`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with \`echo\` separators.\\n- Avoid \`..\` paths outside the working directory, and do not modify files outside it unless explicitly instructed.\\n- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n- Command availability depends on the host; run \`which <command>\` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the \`gh\` CLI when installed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable goal that the runtime pursues across multiple turns. Call it only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one. Do not create a goal for greetings, ordinary questions, or requests without a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion first; if they clearly insist after you warn them that the wording is vague or risky, create the goal anyway. Include \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise and reference long task descriptions by file path. Creating fails if a goal already exists; pass \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued later in this session, recurring or once.\\n\\nWhen the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: \\"around 9\\" → \`57 8 * * *\`, \\"hourly\\" → \`7 * * * *\`.\\n\\nTasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with \`coalescedCount\` > 1: act on the latest state once. The final fire carries \`stale=\\"true\\"\`, so call CronCreate again with the same \`cron\` and \`prompt\` if the schedule is still wanted.\\n\\nUsers cannot manage cron tasks themselves: after creating one, tell the user its \`id\` and that they can ask you to cancel or change it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a live cron task by its \`id\`. Fired one-shots and expired tasks are already gone; if an id is not found, call CronList instead of retrying it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List this session's cron tasks. Read-only. \`stale: true\` marks a recurring task whose next fire is its last. After a context compaction, call this instead of guessing ids.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash \`sed\`.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.\\n\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, budgets with what remains of each, and the terminal reason once it has stopped. Returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — recursive from the search root; \`src/*.ts\` — only directly inside \`src/\`\\n- \`src/**/*.ts\` — recursive beneath \`src/\`\\n- \`*.{ts,tsx}\` and \`{src,test}/**/*.ts\` — brace expansion\\n\\nFollow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.\\n\\nAvoid broad searches in dependency or build-output directories, especially with \`include_ignored\`; prefer a narrow \`path\` or \`pattern\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files are searched by default.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Read", "description": "Read a UTF-8 or UTF-16 text file from the active environment's filesystem, or a \`kimi-file://\` attachment of this session.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Output is \`<line-number>\\\\t<content>\` per line. A \`<system>\` status block may follow; it is not part of the file.\\n- Results are bounded by \`max_chars\`: 100000 by default, up to 100000.\\n- If the status block reports an incomplete range, continue with its \`Next Read\` arguments exactly. Do not answer from a partial page when the task requires the remaining content.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -9007199254740991, "exclusiveMaximum": 0 } ] }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ReadMediaFile", "description": "Read media content from a file.\\n\\nAny reported local attachment path belongs to the server; external converters must be able to access that filesystem.\\n\\n- Read multiple files in parallel when possible.\\n- After generating or editing media via commands or scripts, read the result back before continuing.\\n- Maximum size: 100MB.\\n\\n**Capabilities**\\n\\n- This tool supports image and video files.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to an image or video file, or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories and text files are not supported." }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load one or more tools by name so you can call them. The loadable names are listed in the <tools_added>/<tools_removed> announcements in the system context — fold them in order to get the current list. If you have not seen a <tools_added> announcement in this session, no tools are currently loadable — do not call select_tools. Pass the exact tool name(s) you need — plugin, skill, or category names do not work. The full definitions become available immediately, so you can call them directly in your next tool call. Only announced names are loadable — tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "minItems": 1, "type": "array", "items": { "type": "string" }, "description": "Exact tool names to load, taken from the latest announced tool list." } }, "required": [ "names" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget for the current goal, only when the user clearly states one, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not set one for vague wording such as \\"spend some time\\" or \\"try to be quick\\". Convert a compound time to one unit first: \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status, including task IDs for \`TaskOutput\`.\\n\\nAfter context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With \`active_only=false\`, \`lost\` tasks from previous processes may appear; treat them as terminated.\\n\\nThis tool is read-only and safe in plan mode; it does not return task output.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a non-blocking snapshot of a running or completed background task.\\n\\nUse after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. \`active\` resumes a paused or blocked goal when the user explicitly asks you to work on it again. \`complete\` and \`blocked\` end autonomous work: while a goal is active, its full reminder states exactly when each one is warranted; later reminders keep the current goal state and point back to those rules. Follow them, and do not call this tool merely because you finished a slice of work. After \`complete\` or \`blocked\`, write the completion summary or the blocker explanation in your next message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Use Write only for new files, complete replacements, or content with little continuity; use Edit for every incremental change to an existing file.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
        [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Bash" ], "time": "<time>" }
        [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will mutate a file." }
        [emit] tool.call.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "agentId": "main", "length": 3, "tokens": 786, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 786 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will mutate a file." } }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
        [emit] tool.progress               { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "removed" } }
        [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "output": "removed" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_bash", "result": { "output": "removed" } }, "time": "<time>" }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The command completed." }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 795, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 1558, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1558, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1558, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "agentId": "main", "length": 5, "tokens": 804, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 804 }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 795, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The command completed." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 795, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "I will mutate a file." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" } ] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "tool", "content": [ { "type": "text", "text": "removed" } ], "toolCallId": "call_bash" }, "meta": { "source": "tool" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "The command completed." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 795, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-2" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
        [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
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

      ctx.appendUserTurn('draft the plan');
      await injectDynamic();
      ctx.appendAssistantTurn(1, 'Plan drafted.');

      await ctx.undoHistory(1);
      ctx.appendUserMessage([{ type: 'text', text: 'new plan request' }]);
      await injectDynamic();

      expect(lastUserText(context.get())).toContain('Plan mode is active');
    });
  });

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function injectDynamic(): Promise<void> {
    await runWillBeginStepHooks(ctx.get(IAgentLoopService) as StubLoop, false);
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
