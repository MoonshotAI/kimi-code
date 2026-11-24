import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentPlanService } from '#/features/plan/plan';
import { AgentPlanService } from '#/features/plan/planService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { ToolCall } from '@moonshot-ai/core/llm/message';
import { memoryOutputStore } from '#/tool/executor';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import type { BeforeExecuteDecision } from '#/agent/toolExecutor/toolHooks';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { ExitPlanModeTool } from '#/features/plan/tools/exit-plan-mode/exitPlanModeTool';
import type { ExitPlanModeInput } from '#/features/plan/tools/exit-plan-mode/exit-plan-mode';

import { createReminderStub } from '../reminder/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { registerTestAgentWireServices } from '../../wire/stubs';
import { stubPermissionModeService } from '../../agent/permissionMode/stubs';
import { stubPlanEnvironment } from './stubs';
import { stubLoopWithHooks } from '../../agent/loop/stubs';
import { registerLogServices } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';

const TEMP_DIR = '/var/folders/x/T';
const PLAN_ID = 'plan-1';
const PLAN_PATH = `${TEMP_DIR}/agents/${MAIN_AGENT_ID}/plans/${PLAN_ID}.md`;
const PLAN_CONTENT = '# Plan\n\n1. Do the thing.\n';

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] as const;

type AskResult = Extract<PermissionPolicyResult, { kind: 'ask' }>;

function mapResolution(
  resolution: PermissionPolicyResolution | undefined,
): BeforeExecuteDecision | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.kind === 'deny') {
    return { veto: { output: resolution.message ?? '', isError: true } };
  }
  if (resolution.kind === 'approve') {
    return resolution.executionMetadata === undefined
      ? undefined
      : { executionMetadata: resolution.executionMetadata };
  }
  if (resolution.kind !== 'result') {
    throw new Error('the review stub only resolves synthetic results, approvals and denials');
  }
  return { veto: resolution.result };
}

interface BranchResult {
  readonly outcome: string;
  readonly modelView: string;
  readonly planActiveAfter: boolean;
}

describe('ExitPlanMode approval branches end to end', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executor: IAgentToolExecutorService;
  let files: Map<string, string>;
  let approvalResponse: ApprovalResponse;
  let nonInteractive: boolean;
  const summary: string[] = [];

  beforeEach(() => {
    disposables = new DisposableStore();
    files = new Map([[PLAN_PATH, PLAN_CONTENT]]);
    approvalResponse = { decision: 'approved' };
    nonInteractive = false;

    const environment = stubPlanEnvironment({
      fs: createFakeHostFs({
        mkdir: async () => undefined,
        readText: async (path: string) => files.get(path) ?? '',
        writeText: async (path: string, content: string) => {
          files.set(path, content);
        },
        realpath: async (path: string) => (path.startsWith('/var/') ? `/private${path}` : path),
      }),
      tempDir: TEMP_DIR,
    });

    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution: async () => {
        throw new Error('resolvePermissionResolution is not used by the plan guard');
      },
      requestToolApproval: async (_context, ask: AskResult) => {
        if (nonInteractive) return mapResolution(ask.resolveNonInteractive?.());
        return mapResolution(ask.resolveApproval?.(approvalResponse));
      },
      formatDenyMessage: (message: string) => message,
      formatApprovalRejectionMessage: (toolName, result) =>
        `Tool "${toolName}" was not run (${result.decision}).`,
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerStateServices(reg);
        registerTestAgentWireServices(reg, 'wire/plan-e2e');
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolExecutorService, AgentToolExecutorService);
        reg.defineInstance(IAgentTaskOutputService, { open: memoryOutputStore().open } as unknown as IAgentTaskOutputService);
        reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
        reg.defineInstance(ITelemetryService, { track2: () => {}, setContext: () => {} } as unknown as ITelemetryService);
        reg.defineInstance(IAgentToolResultTruncationService, {
          _serviceBrand: undefined,
          truncateForModel: async (input: { result: ExecutableToolResult }) => input.result,
          isSpillFilePath: () => false,
          isWireJournalPath: () => false,
        } as unknown as IAgentToolResultTruncationService);
        reg.defineInstance(IEventBus, {
          publish: () => {},
          subscribe: () => ({ dispose: () => {} }),
        } as unknown as IEventBus);
        registerLogServices(reg);
        reg.defineInstance(IAgentEnvironmentService, environment);
        reg.defineInstance(IBlobStore, {
          _serviceBrand: undefined,
          put: async () => {},
        } as unknown as IBlobStore);
        reg.definePartialInstance(IHostEnvironment, { pathClass: 'posix' });
        reg.defineInstance(IHostFileSystem, environment.inspect().fs ?? createFakeHostFs());
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 'session',
          workspaceId: 'workspace',
          sessionDir: TEMP_DIR,
          sessionScope: 'sessions/session',
          cwd: '/workspace',
        }));
        reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
        reg.defineInstance(IAgentReminderService, createReminderStub());
        reg.defineInstance(IAgentToolApprovalService, toolApproval);
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => 'manual'));
        reg.defineInstance(IAgentStateService, new AgentStateService());
        reg.define(IAgentPlanService, AgentPlanService);
      },
      strict: true,
    });
    executor = ix.get(IAgentToolExecutorService);
  });

  afterEach(() => disposables.dispose());

  async function runBranch(
    name: string,
    args: ExitPlanModeInput,
    response: ApprovalResponse,
    interactive = true,
  ): Promise<BranchResult> {
    approvalResponse = response;
    nonInteractive = !interactive;
    const plan = ix.get(IAgentPlanService);
    if ((await plan.status()) === null) await plan.enter(PLAN_ID);

    const tool = new ExitPlanModeTool(plan);
    ix.get(IAgentToolRegistryService).register(tool);
    const call: ToolCall = {
      type: 'function',
      id: `call_${name}`,
      name: 'ExitPlanMode',
      arguments: JSON.stringify(args),
    };
    const handler = executor.executor.execute(call, { origin: 'loop', turnId: 0, step: 0 });
    await handler;
    const final = await handler.wait();
    ix.get(IAgentToolRegistryService).unregister(tool.name);

    const text = final.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    const isError = final.outcome.type !== 'success';
    const modelView = renderToolResultForModel({ output: text, isError })
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    const outcome =
      final.outcome.type === 'success'
        ? 'success'
        : `${final.outcome.type} (${final.outcome.error.type}@${final.outcome.error.phase})`;
    const planActiveAfter = (await plan.status()) !== null;
    summary.push(
      [
        `=== ${name} ===`,
        `outcome: ${outcome}`,
        `plan mode active after: ${planActiveAfter}`,
        `model receives (isError=${isError}):`,
        modelView,
        '',
      ].join('\n'),
    );
    return { outcome, modelView, planActiveAfter };
  }

  it('captures the model-facing result for every approval branch', async () => {
    const approvedPlain = await runBranch('approved (no options)', {}, { decision: 'approved' });
    expect(approvedPlain.outcome).toBe('success');
    expect(approvedPlain.planActiveAfter).toBe(false);
    expect(approvedPlain.modelView).not.toContain('ERROR');

    const approvedOption = await runBranch(
      'approved (selected Approach B)',
      { options: [...options] },
      { decision: 'approved', selectedLabel: 'Approach B' },
    );
    expect(approvedOption.outcome).toBe('success');
    expect(approvedOption.modelView).toContain('Selected approach: Approach B');

    const revise = await runBranch(
      'revise (feedback)',
      {},
      { decision: 'rejected', selectedLabel: 'Revise', feedback: 'Add verification.' },
    );
    expect(revise.outcome).toContain('failed');
    expect(revise.planActiveAfter).toBe(true);
    expect(revise.modelView).toContain('Add verification.');

    const dismissed = await runBranch('dismissed (cancelled)', {}, { decision: 'cancelled' });
    expect(dismissed.outcome).toContain('failed');
    expect(dismissed.planActiveAfter).toBe(true);

    const rejectExit = await runBranch(
      'reject and exit',
      {},
      { decision: 'rejected', selectedLabel: 'Reject and Exit' },
    );
    expect(rejectExit.outcome).toContain('failed');
    expect(rejectExit.planActiveAfter).toBe(false);

    const hardDeny = await runBranch('hard deny (non-interactive)', {}, { decision: 'approved' }, false);
    expect(hardDeny.outcome).toContain('failed');
    expect(hardDeny.planActiveAfter).toBe(true);

    writeFileSync(join(tmpdir(), 'exit-plan-mode-e2e-summary.txt'), summary.join('\n'));
  });
});
