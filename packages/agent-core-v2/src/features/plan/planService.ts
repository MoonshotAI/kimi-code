import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { normalize } from 'pathe';

import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { Error2, ErrorCodes } from '#/errors';
import { generateHeroSlug } from '#/_base/utils/hero-slug';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { PlanModeInjection } from '#/features/plan/injection/planModeInjection';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';
import { IBlobStore } from '#/persistence/interface/blobStore';
import type { EnvironmentLease, EnvironmentPath } from '#/environment/environment';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ContextUndone } from '#/agent/undo/undoService';
import type { ToolFileAccess } from '#/tool/toolContract';
import {
  IAgentPlanService,
  type PlanData,
} from './plan';
import { ExitPlanModeReview } from './exitPlanModeReview';
import {
  PlanModeCancel,
  PlanModeEnter,
  PlanModeExit,
  planKey,
  PlanRevision,
} from './planOps';

interface PlanFileTarget {
  readonly fs: IHostFileSystem;
  readonly path: string;
  readonly environmentPath: EnvironmentPath;
}

export class AgentPlanService extends Service implements IAgentPlanService {
  declare readonly _serviceBrand: undefined;

  private readonly review: ExitPlanModeReview;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @IBlobStore private readonly blobs: IBlobStore,
    @IAgentReminderService reminder: IAgentReminderService,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(planKey);

    this.review = new ExitPlanModeReview(this, this.toolApproval, telemetry);

    this._register(
      this.dispatcher.hooks.onDidRestore.register('plan', async (_ctx, next) => {
        this.restoreTelemetryMode();
        await next();
      }),
    );
    this._register(
      eventBus.subscribe(ContextUndone, () => {
        this.restoreTelemetryMode();
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ agentId: this.agentCtx.agentId, planMode: this.isActive }),
        );
      }),
    );

    this._register(new PlanModeInjection(reminder, this, this.context, agentState));
    this._register(this.registerPlanGuard(toolExecutor));
  }

  private registerPlanGuard(toolExecutor: IAgentToolExecutorService): IDisposable {
    return toolExecutor.onBeforeExecuteTool((event) => this.guardToolExecution(event));
  }

  private async guardToolExecution(event: BeforeToolExecuteEvent): Promise<void> {
    const toolName = event.toolCall.name;
    const plan = await this.status();

    if (toolName === 'ExitPlanMode') {
      if (plan !== null && this.modeService.mode !== 'auto') {
        event.waitUntil(() => this.review.requestApproval(event));
      }
      return;
    }

    if (plan === null) {
      return;
    }

    if (toolName === 'Write' || toolName === 'Edit') {
      const target = this.planFileTarget(plan.id);
      if (target !== undefined && (await this.writesOnlyPlanFile(event, target))) {
        event.allow();
        return;
      }
      event.veto(
        denyToolExecution(this.toolApproval.formatDenyMessage(planModeWriteDeniedMessage(plan.path))),
      );
      return;
    }

    if (toolName === 'TaskStop') {
      event.veto(
        denyToolExecution(
          this.toolApproval.formatDenyMessage(
            'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
          ),
        ),
      );
      return;
    }

    if (toolName === 'CronCreate' || toolName === 'CronDelete') {
      event.veto(
        denyToolExecution(
          this.toolApproval.formatDenyMessage(
            `${toolName} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
          ),
        ),
      );
      return;
    }
  }

  private get isActive(): boolean {
    return this.agentState.get(planKey).active;
  }

  private restoreTelemetryMode(): void {
    this.telemetry.setContext({ mode: this.isActive ? 'plan' : 'agent' });
  }

  private createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(id = this.createPlanId(), createFile = false): Promise<void> {
    if (this.isActive) {
      throw new Error2(ErrorCodes.SESSION_PLAN_MODE_INVALID, 'Already in plan mode');
    }

    const target = this.planFileTarget(id);
    let enterRecorded = false;
    try {
      if (target !== undefined) {
        await this.ensurePlanDirectory(target);
      }
      await this.dispatcher.dispatch(new PlanModeEnter({ agentId: this.agentCtx.agentId, id }));
      this.telemetry.setContext({ mode: 'plan' });
      enterRecorded = true;
      if (createFile && target !== undefined) {
        await this.writeEmptyPlanFile(target);
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      }
      throw error;
    }
  }

  cancel(id?: string): void {
    void this.dispatcher.dispatch(new PlanModeCancel({ agentId: this.agentCtx.agentId, id }));
    this.telemetry.setContext({ mode: 'agent' });
  }

  async clear(): Promise<void> {
    const state = this.agentState.get(planKey);
    if (!state.active || state.id === undefined) return;
    const target = this.planFileTarget(state.id);
    if (target === undefined) return;
    await this.writeEmptyPlanFile(target);
  }

  exit(id?: string): void {
    void this.dispatcher.dispatch(new PlanModeExit({ agentId: this.agentCtx.agentId, id }));
    this.telemetry.setContext({ mode: 'agent' });
  }

  async recordRevision(): Promise<void> {
    const state = this.agentState.get(planKey);
    if (!state.active || state.id === undefined) return;
    const id = state.id;
    const target = this.planFileTarget(id);
    if (target === undefined) return;
    const content = await target.fs.readText(target.path);
    const bytes = Buffer.from(content, 'utf8');
    const version = (state.revisionCount?.[id] ?? 0) + 1;
    const scope = this.agentCtx.scope();
    const key = `plan/${id}/v${version}.md`;
    await this.blobs.put(scope, key, bytes);
    await this.dispatcher.dispatch(
      new PlanRevision({
        agentId: this.agentCtx.agentId,
        id,
        version,
        key,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      }),
    );
  }

  async status(): Promise<PlanData> {
    const state = this.agentState.get(planKey);
    if (!state.active || state.id === undefined) return null;
    const target = this.planFileTarget(state.id);
    if (target === undefined) {
      return { id: state.id, content: '', path: '' };
    }
    let content = '';
    try {
      content = await target.fs.readText(target.path);
    } catch (error) {
      if (!isHostFsNotFound(error)) throw error;
    }
    return {
      id: state.id,
      content,
      path: target.path,
    };
  }

  private planFileTarget(id: string): PlanFileTarget | undefined {
    let lease: EnvironmentLease;
    try {
      lease = this.environment.acquire(['fs']);
    } catch {
      return undefined;
    }
    try {
      const fs = lease.environment.fs;
      if (fs === undefined) return undefined;
      const tempDir = lease.environment.host.tempDir ?? tmpdir();
      return {
        fs,
        environmentPath: lease.environment.path,
        path: lease.environment.path.join(
          tempDir,
          'kimi-code',
          'plans',
          this.agentCtx.agentId,
          `${id}.md`,
        ),
      };
    } finally {
      lease.dispose();
    }
  }

  private async writesOnlyPlanFile(
    context: ResolvedToolExecutionHookContext,
    target: PlanFileTarget,
  ): Promise<boolean> {
    const writeAccesses = (context.execution.accesses ?? []).filter(
      (access): access is ToolFileAccess =>
        access.kind === 'file' &&
        (access.operation === 'write' || access.operation === 'readwrite'),
    );
    if (writeAccesses.length === 0) return false;
    for (const access of writeAccesses) {
      if (await this.isPlanFilePath(target, access.path)) continue;
      return false;
    }
    return true;
  }

  private async isPlanFilePath(target: PlanFileTarget, path: string): Promise<boolean> {
    if (normalize(path) === normalize(target.path)) return true;
    const [accessReal, planReal] = await Promise.all([
      canonicalizeExistingPrefix(target, path),
      canonicalizeExistingPrefix(target, target.path),
    ]);
    return normalize(accessReal) === normalize(planReal);
  }

  private async writeEmptyPlanFile(target: PlanFileTarget): Promise<void> {
    await this.ensurePlanDirectory(target);
    await target.fs.writeText(target.path, '');
  }

  private async ensurePlanDirectory(target: PlanFileTarget): Promise<void> {
    await target.fs.mkdir(target.environmentPath.dirname(target.path), {
      recursive: true,
      mode: 0o700,
    });
  }
}

async function canonicalizeExistingPrefix(target: PlanFileTarget, path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (let i = 0; i < 256; i++) {
    try {
      const real = await target.fs.realpath(current);
      return tail.length === 0 ? real : target.environmentPath.join(real, ...tail.toReversed());
    } catch (error) {
      if (!isHostFsNotFound(error)) return path;
      const parent = target.environmentPath.dirname(current);
      if (parent === current) return path;
      tail.push(target.environmentPath.basename(current));
      current = parent;
    }
  }
  return path;
}

function planModeWriteDeniedMessage(planFilePath: string | null): string {
  const target =
    planFilePath === null || planFilePath.length === 0
      ? '(no plan file selected yet)'
      : planFilePath;
  return (
    `Plan mode is active. You may only write to the current plan file: ${target}. ` +
    'Call ExitPlanMode to exit plan mode before editing other files.'
  );
}

export { AgentPlanService as Plan };
