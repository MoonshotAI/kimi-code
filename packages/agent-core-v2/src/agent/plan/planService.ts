/**
 * `plan` domain (L3) — `IAgentPlanService` implementation.
 *
 * Manages plan-mode state through `wire`, injects plan-mode context through
 * `contextInjector`, writes optional plan files through `hostFileSystem`,
 * and tags mode telemetry through `telemetry`. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { generateHeroSlug } from '#/_base/utils/hero-slug';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { PlanModeInjection } from '#/agent/plan/injection/planModeInjection';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import {
  IAgentPlanService,
  type PlanData,
  type PlanFilePath,
} from './plan';
import {
  PlanModel,
  planModeCancel,
  planModeEnter,
  planModeExit,
} from './planOps';

export class AgentPlanService extends Disposable implements IAgentPlanService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
    @IAgentWireService private readonly wire: IWireService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
  ) {
    super();

    this._register(this.wire.onRestored(() => this.restoreTelemetryMode()));

    this._register(new PlanModeInjection(dynamicInjector, this, this.context));
  }

  private get isActive(): boolean {
    return this.wire.getModel(PlanModel).active;
  }

  private currentPlanFilePath(): PlanFilePath {
    const state = this.wire.getModel(PlanModel);
    if (!state.active || state.id === undefined) return null;
    return this.planFilePathFor(state.id);
  }

  private restoreTelemetryMode(): void {
    if (this.isActive) {
      this.telemetryContext.set({ mode: 'plan' });
    }
  }

  private createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(id = this.createPlanId(), createFile = false): Promise<void> {
    if (this.isActive) {
      throw new Error('Already in plan mode');
    }

    const planFilePath = this.planFilePathFor(id);
    let enterRecorded = false;
    try {
      await this.ensurePlanDirectory(planFilePath);
      this.wire.dispatch(planModeEnter({ id }));
      this.telemetryContext.set({ mode: 'plan' });
      enterRecorded = true;
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      }
      throw error;
    }
  }

  cancel(id?: string): void {
    this.wire.dispatch(planModeCancel({ id }));
    this.telemetryContext.set({ mode: 'agent' });
  }

  async clear(): Promise<void> {
    const path = this.currentPlanFilePath();
    if (path === null) return;
    await this.writeEmptyPlanFile(path);
  }

  exit(id?: string): void {
    this.wire.dispatch(planModeExit({ id }));
    this.telemetryContext.set({ mode: 'agent' });
  }

  async status(): Promise<PlanData> {
    const state = this.wire.getModel(PlanModel);
    if (!state.active || state.id === undefined) return null;
    const path = this.planFilePathFor(state.id);
    let content = '';
    try {
      content = await this.hostFs.readText(path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: state.id,
      content,
      path,
    };
  }

  private planFilePathFor(id: string): string {
    return join(this.sessionCtx.sessionDir, 'agents', this.agentCtx.agentId, 'plans', `${id}.md`);
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.hostFs.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.hostFs.mkdir(dirname(path), { recursive: true });
  }
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

export { AgentPlanService as Plan };

registerScopedService(
  LifecycleScope.Agent,
  IAgentPlanService,
  AgentPlanService,
  InstantiationType.Delayed,
  'plan',
);
