import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { ToolCall } from '#human/message';
import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { IAgentPlanService, type PlanData } from '#/features/plan/plan';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
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
  let context: IAgentLoopService;
  let ctx: TestAgentContext;
  let permissionRules: IAgentPermissionRulesService;
  let plan: IAgentPlanService;
  let profile: IAgentLoopService;
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
    context = ctx.get(IAgentLoopService);
    permissionRules = ctx.get(IAgentPermissionRulesService);
    plan = ctx.get(IAgentPlanService);
    profile = ctx.get(IAgentLoopService);
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
      remoteCtx.get(IAgentLoopService).update({ activeToolNames: [...tools] });
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
        await permissionRules.addRules([{ decision: 'allow', scope: 'user', pattern: 'ExitPlanMode' }]);
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
      expect(toolResultText(context.history())).toContain('Plan rejected by user');
    });

    it('executes later tool calls in the same batch after plan rejection', async () => {
      const runner = createCommandRunner('continued');
      const exec = vi.spyOn(runner, 'spawn');
      const { files, fakes: baseFakes } = createPlanFileFakes(undefined);
      const fakes: PlanFakes = {
        fs: baseFakes.fs,
        runner,
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
        arguments: '{"command":"printf continued","timeout":60}',
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
      expect(exec).toHaveBeenCalledTimes(1);
      expect(ctx.llmCalls).toHaveLength(1);
      expect(toolResultText(context.history())).toContain('Plan rejected by user');
      expect(toolResultText(context.history())).toContain('continued');
      expect(toolResultText(context.history())).not.toContain(
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
      await permissionRules.addRules([
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
      expect(toolResultText(context.history())).not.toContain('denied by permission rule');
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
        [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal", "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal" }
        [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Inspect without mutating files" }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "origin": { "kind": "injection", "variant": "plan_mode" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
        [wire] tool_select.initialized     { "agentId": "main", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "ReadMediaFile", "select_tools", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will inspect safely.", "block": 0 }
        [emit] tool.call.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" }
        [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 2, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will inspect safely." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" } ], "providerMessageId": "mock-1", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 789 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "block": 0, "part": { "type": "text", "text": "I will inspect safely." }, "startedAt": "<time>" }, "time": "<time>" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [wire] token_counting.measured     { "agentId": "main", "length": 3, "tokens": 789, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": {} }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: printf plan-safe", "command": "printf plan-safe", "pid": 42, "exitCode": null, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: printf plan-safe", "command": "printf plan-safe", "pid": 42, "exitCode": null, "parentToolCallId": "call_bash", "timeoutMs": 60000 } }, "output": { "offset": 0, "text": "plan-safe" } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: printf plan-safe", "command": "printf plan-safe", "pid": 42, "exitCode": 0, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: printf plan-safe", "command": "printf plan-safe", "pid": 42, "exitCode": 0, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "success", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: printf plan-safe", "command": "printf plan-safe", "pid": 42, "exitCode": 0, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "output": "plan-safe" }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "plan-safe" } ], "toolCallId": "call_bash" } ] }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_bash", "result": { "output": "plan-safe", "isError": false } }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 766, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The safe command printed plan-safe.", "block": 0 }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 4, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "The safe command printed plan-safe." } ], "toolCalls": [], "providerMessageId": "mock-2", "usage": { "inputOther": 793, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 793, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 1559, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1559, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1559, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 805 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "stepUuid": "<uuid-6>", "block": 0, "part": { "type": "text", "text": "The safe command printed plan-safe." }, "startedAt": "<time>" }, "time": "<time>" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 793, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [wire] token_counting.measured     { "agentId": "main", "length": 5, "tokens": 805, "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
      `);

      expect(ctx.llmCalls).toHaveLength(2);
      expect(toolResultText(context.history())).toContain('plan-safe');
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
        [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal", "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal" }
        [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Remove forbidden.txt" }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "origin": { "kind": "injection", "variant": "plan_mode" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
        [wire] tool_select.initialized     { "agentId": "main", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "ReadMediaFile", "select_tools", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will mutate a file.", "block": 0 }
        [emit] tool.call.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" }
        [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 2, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will mutate a file." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" } ], "providerMessageId": "mock-1", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 786 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "block": 0, "part": { "type": "text", "text": "I will mutate a file." }, "startedAt": "<time>" }, "time": "<time>" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [wire] token_counting.measured     { "agentId": "main", "length": 3, "tokens": 786, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": {} }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: rm forbidden.txt", "command": "rm forbidden.txt", "pid": 42, "exitCode": null, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: rm forbidden.txt", "command": "rm forbidden.txt", "pid": 42, "exitCode": null, "parentToolCallId": "call_bash", "timeoutMs": 60000 } }, "output": { "offset": 0, "text": "removed" } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: rm forbidden.txt", "command": "rm forbidden.txt", "pid": 42, "exitCode": 0, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "running", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: rm forbidden.txt", "command": "rm forbidden.txt", "pid": 42, "exitCode": 0, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.updated                { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "taskId": "<taskId>", "status": "success", "detached": false, "fields": { "task": { "kind": "process", "description": "Bash: rm forbidden.txt", "command": "rm forbidden.txt", "pid": 42, "exitCode": 0, "parentToolCallId": "call_bash", "timeoutMs": 60000 } } }
        [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "output": "removed" }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "removed" } ], "toolCallId": "call_bash" } ] }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_bash", "result": { "output": "removed", "isError": false } }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 763, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The command completed.", "block": 0 }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 4, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "The command completed." } ], "toolCalls": [], "providerMessageId": "mock-2", "usage": { "inputOther": 789, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 789, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 1552, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1552, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1552, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 798 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "stepUuid": "<uuid-6>", "block": 0, "part": { "type": "text", "text": "The command completed." }, "startedAt": "<time>" }, "time": "<time>" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 789, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [wire] token_counting.measured     { "agentId": "main", "length": 5, "tokens": 798, "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
      `);
      expect(toolResultText(context.history())).toContain('removed');
    });
  });

  describe('plan mode injection cadence', () => {
    it('dedupes immediate repeats and emits sparse reminders after assistant turns', async () => {
      await plan.enter('test-plan', false);

      await injectDynamic();
      const afterFull = context.history().length;
      expect(lastUserText(context.history())).toContain('Plan mode is active');
      expect(lastUserText(context.history())).toContain('Plan file:');

      await injectDynamic();
      expect(context.history()).toHaveLength(afterFull);

      ctx.appendAssistantTurn(1, 'assistant one');
      ctx.appendAssistantTurn(2, 'assistant two');
      await injectDynamic();

      expect(lastUserText(context.history())).toContain('Plan mode still active');
      expect(lastUserText(context.history())).toContain('Plan file:');
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

      expect(lastUserText(context.history())).toContain('Re-entering Plan Mode');
      expect(lastUserText(context.history())).toContain('Read the existing plan file');
    });

    it('emits one exit reminder after leaving plan mode', async () => {
      await plan.enter('test-plan', false);
      await injectDynamic();

      plan.exit();
      await injectDynamic();
      const afterExit = context.history().length;
      expect(lastUserText(context.history())).toContain('Plan mode is no longer active');

      await injectDynamic();
      expect(context.history()).toHaveLength(afterExit);
    });

    it('keeps the preserved injection index aligned after undo removes earlier messages', async () => {
      await plan.enter('test-plan', false);

      ctx.appendUserTurn('draft the plan');
      await injectDynamic();
      ctx.appendAssistantTurn(1, 'Plan drafted.');

      await ctx.undoHistory(1);
      ctx.appendUserMessage([{ type: 'text', text: 'new plan request' }]);
      await injectDynamic();

      expect(lastUserText(context.history())).toContain('Plan mode is active');
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
