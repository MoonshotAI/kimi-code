import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';
import { createDecorator } from '../../di';
import { IAgentConfigService } from '../config';
import { ILifecycleService } from '../lifecycle';
import { IRecordsService } from '../records';
import { IReplayService } from '../replay';
import { exitReminder, fullReminder } from '../injection/plan-mode';
import { generateHeroSlug } from '../../utils/hero-slug';

export type PlanData = null | {
  id: string;
  content: string;
  path: string;
};
export type PlanFilePath = string | null;

export class PlanMode {
  protected _isActive = false;
  protected _planId: null | string = null;
  protected _planFilePath: PlanFilePath = null;
  private wasActive = false;

  constructor(
    private readonly kaos?: Kaos,
    private readonly homedir?: string,
    private readonly emitStatusUpdated?: () => void,
    @IRecordsService private readonly records?: IRecordsService,
    @IReplayService private readonly replayBuilder?: IReplayService,
    @IAgentConfigService private readonly config?: IAgentConfigService,
    @ILifecycleService lifecycle?: ILifecycleService,
  ) {
    lifecycle?.onBeforePrompt((ctx) => {
      if (this._isActive) {
        if (!this.wasActive) {
          this.wasActive = true;
          ctx.injectSystemReminder(fullReminder(this._planFilePath), {
            kind: 'injection',
            variant: 'plan_mode',
          });
        }
      } else if (this.wasActive) {
        this.wasActive = false;
        ctx.injectSystemReminder(exitReminder(), {
          kind: 'injection',
          variant: 'plan_mode',
        });
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

    if (emitStatus) this.emitStatusUpdated?.();
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
    this.emitStatusUpdated?.();
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
    this.emitStatusUpdated?.();
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
