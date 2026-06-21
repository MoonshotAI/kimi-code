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
 * under a `try/finally` that guards the replay builder's `postRestoring` flag.
 *
 * Event-ized (M5.3): the resume body runs as an `onAgentWillResume` handler
 * rather than being invoked inline. The {@link resume} trigger fires
 * `fireAgentWillResume`; the subscribed handler performs the work, bracketed
 * by the `fireAgentWillResume` / `fireAgentDidResume` lifecycle hooks.
 */
export interface IAgentResumeService {
  /**
   * Triggers a resume and returns the replay result. Mirrors the former
   * `Agent.resume` signature and return shape exactly.
   */
  resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }>;
}

export class AgentResumeService implements IAgentResumeService {
  /**
   * Per-call handoff between the {@link resume} trigger and the
   * `onAgentWillResume` handler that performs the work. `resume()` is
   * serialized per agent (the `SessionHost` dedupes concurrent resumes by
   * agent id), so a single pending slot per service is sufficient.
   */
  private pendingOptions: AgentRecordsReplayOptions | undefined;
  private pendingResult: { warning?: string } | undefined;

  constructor(private readonly host: AgentResumeHost) {
    // The resume body runs as an `onAgentWillResume` handler. The trigger
    // (`resume()`) fires the hook; this handler replays the records and
    // restores the runtime stages, then captures the replay result so the
    // trigger can return it. The handler deliberately does NOT fire
    // `fireAgentWillResume` — the trigger owns that — so there is exactly one
    // WillResume fire and no recursion.
    this.host.lifecycle.onAgentWillResume(() => this.runResume());
  }

  /**
   * Triggers a resume by firing `fireAgentWillResume`; the subscribed handler
   * performs the actual replay + stage restoration. Returns the replay result
   * (including any `warning`) once the handler completes. For id-less agents
   * the lifecycle hooks are skipped (matching the former behavior) and the
   * body runs directly.
   */
  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
    this.pendingOptions = options;
    this.pendingResult = undefined;
    try {
      if (this.host.id !== undefined) {
        await this.host.lifecycle.fireAgentWillResume({ agentId: this.host.id });
      } else {
        await this.runResume();
      }
      return this.pendingResult ?? {};
    } finally {
      this.pendingOptions = undefined;
      this.pendingResult = undefined;
    }
  }

  /**
   * The serialized resume body: replay the records, restore each runtime stage
   * under the `postRestoring` guard, then fire `fireAgentDidResume` and capture
   * the replay result for the trigger to return.
   */
  private async runResume(): Promise<void> {
    const result = await this.host.records.replay(this.pendingOptions);
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
    this.pendingResult = result;
  }
}
