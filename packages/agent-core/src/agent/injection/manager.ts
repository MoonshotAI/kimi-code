import { formatTaskList } from '#/tools/background/task-list';

import type { Agent } from '..';
import { GoalInjector } from './goal';
import type { DynamicInjector } from './injector';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';

const ACTIVE_BACKGROUND_TASK_GUIDANCE =
  'The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before. Do not start duplicates. Use TaskOutput to fetch a task’s result, TaskList to list them, and TaskStop to cancel one.';

export class InjectionManager {
  private readonly injectors: DynamicInjector[];
  // Goal context is injected at continuation boundaries (turn start, each
  // continuation, after compaction) via `injectGoal()`, NOT in the per-step
  // `inject()` loop. Boundary-cadence append-only injection keeps one fresh copy
  // near the tail without mutating the prefix, so prompt caching is preserved and
  // the context does not grow O(n^2) the way per-step injection did.
  private readonly goalInjector: GoalInjector | null;

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginSessionStartInjector(agent),
      new TodoListReminderInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
    ];
    this.goalInjector = agent.type === 'main' ? new GoalInjector(agent) : null;
  }

  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  /**
   * Appends a fresh goal-context reminder at a continuation boundary. Append-only
   * (never mutates the prefix) so prompt caching is preserved; no-ops when goal
   * mode is off, the agent is not the main agent, or there is nothing to inject.
   */
  async injectGoal(): Promise<void> {
    await this.activeGoalInjector()?.inject();
  }

  async injectAfterCompaction(): Promise<void> {
    await this.injectGoal();
    this.injectActiveBackgroundTasks();
    await this.inject();
  }

  /**
   * Post-compaction only: re-surface still-running background tasks. Folding the
   * live context to [recent user prompts, summary] drops the messages that
   * started them and their status updates, so without this the model can forget
   * a task is running and spawn a duplicate. Appended as an `injection`-origin
   * reminder, so the next compaction drops and rebuilds it — kept fresh, never
   * stacked. Runs only on the live path: restore replays the persisted reminder
   * and `FullCompaction.begin` short-circuits before compaction there.
   */
  private injectActiveBackgroundTasks(): void {
    const tasks = this.agent.background.list(true);
    if (tasks.length === 0) return;
    this.agent.context.appendSystemReminder(
      `${ACTIVE_BACKGROUND_TASK_GUIDANCE}\n\n${formatTaskList(tasks, true)}`,
      { kind: 'injection', variant: 'background_task_status' },
    );
  }

  onContextClear(): void {
    for (const injector of this.lifecycleInjectors()) {
      injector.onContextClear();
    }
  }

  onContextCompacted(): void {
    for (const injector of this.lifecycleInjectors()) {
      try {
        injector.onContextCompacted();
      } catch {
        continue;
      }
    }
  }

  onContextMessageRemoved(index: number): void {
    for (const injector of this.lifecycleInjectors()) {
      injector.onContextMessageRemoved(index);
    }
  }

  /** Per-step injectors plus the boundary goal injector, for lifecycle events. */
  private lifecycleInjectors(): DynamicInjector[] {
    const goalInjector = this.activeGoalInjector();
    return goalInjector === null ? this.injectors : [goalInjector, ...this.injectors];
  }

  private activeGoalInjector(): GoalInjector | null {
    return this.goalInjector;
  }
}
