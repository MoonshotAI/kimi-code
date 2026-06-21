import type { IBackgroundService } from '../background';
import type { IContextService } from '../context';
import type { ICronService } from '../cron';
import type { IGoalService } from '../goal';
import type { ILifecycleService } from '../lifecycle';
import type { AgentRecordsReplayOptions, IRecordsService } from '../records';
import type { IReplayService } from '../replay';
import type { ITurnService } from '../turn';

/**
 * Narrow read-only view of the agent that {@link AgentResumeService} needs in
 * order to run the serialized `resume()` orchestration. `Agent` satisfies this
 * structurally, but the service depends only on this interface — never on the
 * concrete `Agent` class — so tests can drive it with a plain stub.
 *
 * The service reads these fields at `resume()` call-time (after the agent has
 * finished constructing), which is why this host can be handed to the service
 * before the underlying services have been resolved, and why no DI cycle is
 * introduced: the service is not injected back into any of the services it
 * orchestrates.
 */
export interface AgentResumeHost {
  readonly id: string | undefined;
  readonly lifecycle: ILifecycleService;
  readonly records: IRecordsService;
  readonly replayBuilder: IReplayService;
  readonly goal: IGoalService;
  readonly background: IBackgroundService;
  readonly cron: ICronService | null;
  readonly context: IContextService;
  readonly turn: ITurnService;
}

/**
 * Owns the agent's serialized `resume()` orchestration: replay the records,
 * then restore each runtime stage (goal / background / cron / context / turn)
 * under a `try/finally` that guards the replay builder's `postRestoring` flag,
 * bracketed by the `fireAgentWillResume` / `fireAgentDidResume` lifecycle
 * hooks.
 */
export interface IAgentResumeService {
  /**
   * Replays the agent's records and restores runtime state. Mirrors the former
   * `Agent.resume` signature and return shape exactly.
   */
  resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }>;
}

export class AgentResumeService implements IAgentResumeService {
  constructor(private readonly host: AgentResumeHost) {}

  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
    if (this.host.id !== undefined) {
      await this.host.lifecycle.fireAgentWillResume({ agentId: this.host.id });
    }
    const result = await this.host.records.replay(options);
    try {
      this.host.replayBuilder.postRestoring = true;
      this.host.goal.normalizeAfterReplay();
      await this.host.background.loadFromDisk();
      await this.host.background.reconcile();
      await this.host.cron?.loadFromDisk();
      this.host.context.finishResume();
      this.host.turn.finishResume();
    } finally {
      this.host.replayBuilder.postRestoring = false;
    }
    if (this.host.id !== undefined) {
      await this.host.lifecycle.fireAgentDidResume({ agentId: this.host.id });
    }
    return result;
  }
}
