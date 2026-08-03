import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Agent } from '..';
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

  constructor(protected readonly agent: Agent) {}

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
      this.agent.records.logRecord({ type: 'plan_mode.enter', id });
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

    if (emitStatus) this.agent.emitStatusUpdated();
  }

  restoreEnter({ id }: { readonly id: string }): void {
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: true,
    });

    this._isActive = true;
    this._planId = id;
    this._planFilePath = this.planFilePathFor(id);
  }

  cancel(id?: string): void {
    this.agent.records.logRecord({ type: 'plan_mode.cancel', id });
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
  }

  async clear(): Promise<void> {
    if (!this._planFilePath) return;
    await this.writeEmptyPlanFile(this._planFilePath);
  }

  exit(id?: string): void {
    this.agent.records.logRecord({ type: 'plan_mode.exit', id });
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
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
      content = await this.agent.kaos.readText(this._planFilePath);
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
    await this.agent.kaos.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.agent.kaos.mkdir(dirname(path), {
      parents: true,
      existOk: true,
    });
  }

  private planFilePathFor(id: string): string {
    const plansDir =
      this.agent.homedir === undefined
        ? join(this.agent.config.cwd, 'plan')
        : join(this.agent.homedir, 'plans');
    return join(plansDir, `${id}.md`);
  }
}

function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}
