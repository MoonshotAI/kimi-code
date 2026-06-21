import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';
import { createDecorator } from '../../di';
import { IAgentConfigService } from '../config';
import { IContextService } from '../context';
import { ILifecycleService } from '../lifecycle';
import { IRecordsService } from '../records';
import { IReplayService } from '../replay';
import { IAgentStatusService } from '../status';
import { exitReminder, fullReminder, reentryReminder, sparseReminder } from '../injection/plan-mode';
import { generateHeroSlug } from '../../utils/hero-slug';

export type PlanData = null | {
  id: string;
  content: string;
  path: string;
};
export type PlanFilePath = string | null;

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;

export class PlanMode {
  protected _isActive = false;
  protected _planId: null | string = null;
  protected _planFilePath: PlanFilePath = null;
  private wasActive = false;
  private injectedAt: number | null = null;

  constructor(
    private readonly kaos?: Kaos,
    private readonly homedir?: string,
    @IAgentStatusService private readonly statusService?: IAgentStatusService,
    @IRecordsService private readonly records?: IRecordsService,
    @IReplayService private readonly replayBuilder?: IReplayService,
    @IAgentConfigService private readonly config?: IAgentConfigService,
    @ILifecycleService lifecycle?: ILifecycleService,
    @IContextService private readonly context?: IContextService,
  ) {
    lifecycle?.onBeforePrompt(async (ctx) => {
      const reminder = await this.computeReminder();
      if (reminder !== undefined) {
        this.injectedAt = this.context?.history.length ?? null;
        ctx.injectSystemReminder(reminder, {
          kind: 'injection',
          variant: 'plan_mode',
        });
      }
    });
    lifecycle?.onContextMessageRemoved((index) => {
      if (this.injectedAt === null) return;
      if (index < this.injectedAt) {
        this.injectedAt -= 1;
      } else if (index === this.injectedAt) {
        this.injectedAt = null;
      }
    });
  }

  createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(id = this.createPlanId(), createFile = false, emitStatus = true): Promise<void> {
    if (this._isActive) {
      throw new Error('Already in plan mode');
    }

    this._isActive = true;
    this._planId = id;
    this._planFilePath = null;

    let enterRecorded = false;
    try {
      const planFilePath = this.planFilePathFor(id);
      this._planFilePath = planFilePath;
      await this.ensurePlanDirectory(planFilePath);
      this.records?.logRecord({ type: 'plan_mode.enter', id });
      enterRecorded = true;
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      } else {
        this._isActive = false;
        this._planId = null;
        this._planFilePath = null;
      }
      throw error;
    }

    if (emitStatus) this.statusService?.notifyStatusChanged();
  }

  restoreEnter({ id }: { readonly id: string }): void {
    this.replayBuilder?.push({
      type: 'plan_updated',
      enabled: true,
    });

    this._isActive = true;
    this._planId = id;
    this._planFilePath = this.planFilePathFor(id);
  }

  cancel(id?: string): void {
    this.records?.logRecord({ type: 'plan_mode.cancel', id });
    this.replayBuilder?.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.statusService?.notifyStatusChanged();
  }

  async clear(): Promise<void> {
    if (!this._planFilePath) return;
    await this.writeEmptyPlanFile(this._planFilePath);
  }

  exit(id?: string): void {
    this.records?.logRecord({ type: 'plan_mode.exit', id });
    this.replayBuilder?.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.statusService?.notifyStatusChanged();
  }

  get isActive() {
    return this._isActive;
  }

  get planFilePath(): PlanFilePath {
    return this._planFilePath;
  }

  async data(): Promise<PlanData> {
    if (!this._planId || !this._planFilePath) return null;
    let content = '';
    try {
      content = (await this.kaos?.readText(this._planFilePath)) ?? '';
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: this._planId,
      content,
      path: this._planFilePath,
    };
  }

  private async computeReminder(): Promise<string | undefined> {
    if (!this._isActive) {
      if (!this.wasActive) return undefined;
      this.wasActive = false;
      this.injectedAt = null;
      return exitReminder();
    }
    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
      if (await this.hasCurrentPlanContent()) {
        return reentryReminder(this._planFilePath);
      }
    }
    const variant = this.getVariant();
    if (variant === null) return undefined;
    return variant === 'full'
      ? fullReminder(this._planFilePath)
      : variant === 'sparse'
        ? sparseReminder(this._planFilePath)
        : reentryReminder(this._planFilePath);
  }

  private getVariant(): 'full' | 'sparse' | 'reentry' | null {
    if (this.injectedAt === null) return 'full';
    const history = this.context?.history ?? [];
    let assistantTurnsSince = 0;
    for (let i = this.injectedAt + 1; i < history.length; i++) {
      const msg = history[i];
      if (msg === undefined) continue;
      if (msg.role === 'assistant') {
        assistantTurnsSince += 1;
        continue;
      }
      if (msg.role === 'user') return 'full';
    }
    if (assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
    if (assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
    return null;
  }

  private async hasCurrentPlanContent(): Promise<boolean> {
    try {
      const data = await this.data();
      return data !== null && data.content.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.kaos?.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.kaos?.mkdir(dirname(path), {
      parents: true,
      existOk: true,
    });
  }

  private planFilePathFor(id: string): string {
    const plansDir =
      this.homedir === undefined
        ? join(this.config?.cwd ?? '', 'plan')
        : join(this.homedir, 'plans');
    return join(plansDir, `${id}.md`);
  }
}

export interface IPlanService extends Pick<PlanMode, keyof PlanMode> {
  readonly _serviceBrand: undefined;
  /** @internal migration bridge — reach the raw manager; do not use in new code. */
  unwrap(): PlanMode;
}

export const IPlanService = createDecorator<IPlanService>('planService');

export class PlanService extends PlanMode implements IPlanService {
  readonly _serviceBrand: undefined;
  unwrap(): PlanMode {
    return this;
  }
}

function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}
