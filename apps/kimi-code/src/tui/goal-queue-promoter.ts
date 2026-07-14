/**
 * Queued-goal promotion for the TUI.
 *
 * When the active goal completes (and the turn has ended), start the next
 * queued goal, if any. This module owns the promotion state machine — the
 * pending / in-flight / timer gates plus the completion and turn-ended gates —
 * and the queue read → create → remove → restore/cancel dance. The session
 * event handler observes the underlying events and forwards the promotion
 * signals here (`onGoalCompletion` / `onSnapshotCleared` / `onTurnEnded`), so
 * goal orchestration stays out of the event-routing controller.
 */

import { createGoal as startGoalCommand } from './commands/goal';
import {
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  type UpcomingGoal,
} from './goal-queue-store';
import { formatErrorMessage } from './utils/event-payload';
import type { CoreSession } from '#/core/index';
import type { SessionEventHost } from './controllers/session-event-handler';

export class GoalQueuePromoter {
  private awaitingClear = false;
  private turnEnded = false;
  private pending = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly host: SessionEventHost) {}

  reset(): void {
    this.generation += 1;
    this.awaitingClear = false;
    this.turnEnded = false;
    this.pending = false;
    this.inFlight = false;
    this.clearTimer();
  }

  /** A goal just completed (snapshot still live); arm the clear gate. */
  onGoalCompletion(): void {
    this.awaitingClear = true;
    this.turnEnded = false;
  }

  /** The completed goal's snapshot was cleared; queue a promotion if armed. */
  onSnapshotCleared(): void {
    if (!this.awaitingClear) return;
    this.awaitingClear = false;
    this.pending = true;
    this.schedule();
  }

  /** A turn ended; a queued promotion is allowed to fire. */
  onTurnEnded(): void {
    this.turnEnded = true;
    this.schedule();
  }

  /** External request (e.g. `/goal next` queued the first goal). */
  request(): void {
    this.pending = true;
    this.turnEnded = true;
    this.schedule();
  }

  /** Re-arm the scheduler after a busy state clears. */
  retry(): void {
    this.schedule();
  }

  /** Surface a low-profile notice when the active goal is blocked with a queue. */
  async notifyBlocked(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return;

    let hasQueuedGoal = false;
    try {
      const queue = await readGoalQueue(session);
      hasQueuedGoal = queue.goals.length > 0;
    } catch {
      return;
    }
    if (!hasQueuedGoal || host.session !== session || host.aborted) return;

    host.showNotice(
      'Goal blocked.',
      'The next queued goal will start only after this goal is complete.',
    );
  }

  private schedule(): void {
    if (!this.pending || !this.turnEnded) return;
    if (this.inFlight) return;
    if (this.timer !== undefined) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = undefined;
      if (!this.pending || !this.turnEnded) return;
      if (this.inFlight) return;
      if (!this.isReady()) {
        return;
      }
      this.inFlight = true;
      void this.promote()
        .then((complete) => {
          if (generation !== this.generation) return;
          if (complete) this.pending = false;
          this.turnEnded = false;
        })
        .catch((error: unknown) => {
          if (generation !== this.generation) return;
          this.turnEnded = false;
          this.host.showError(`Failed to promote queued goal: ${formatErrorMessage(error)}`);
        })
        .finally(() => {
          if (generation === this.generation) this.inFlight = false;
        });
    }, 0);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isReady(session?: CoreSession): boolean {
    return (
      (session === undefined || this.host.session === session) &&
      !this.host.aborted &&
      this.host.state.appState.streamingPhase === 'idle' &&
      this.host.state.queuedMessages.length === 0 &&
      !this.host.state.queuedMessageDispatchPending
    );
  }

  private async promote(): Promise<boolean> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return true;

    let queue;
    try {
      queue = await readGoalQueue(session);
    } catch (error) {
      host.showError(`Failed to read upcoming goals: ${formatErrorMessage(error)}`);
      return false;
    }
    if (host.session !== session || host.aborted) return true;

    const next = queue.goals[0];
    if (next === undefined) return true;

    if (!this.isReady(session)) return false;

    const started = await startGoalCommand(
      host,
      { kind: 'create', objective: next.objective, replace: false },
      next.objective,
      {
        beforeSend: async () => {
          if (!this.isReady(session)) {
            await this.cancelStarted(session);
            return false;
          }
          try {
            await removeGoalQueueItem(session, { goalId: next.id });
          } catch (error) {
            host.showError(
              `Queued goal started, but could not be removed from the queue: ${formatErrorMessage(error)}`,
            );
            await this.cancelStarted(session);
            return false;
          }
          if (this.isReady(session)) {
            return true;
          }
          await this.restoreAndCancel(session, next);
          return false;
        },
        sendConfirmationWithInput: (objective, confirmation) =>
          host.sendQueuedGoalMessage(session, { text: objective }, confirmation),
        onSendError: () => this.restoreAndCancel(session, next),
      },
    );
    return started || host.session !== session || host.aborted;
  }

  private async restoreAndCancel(session: CoreSession, goal: UpcomingGoal): Promise<void> {
    try {
      await restoreGoalQueueItem(session, goal);
    } catch (error) {
      if (this.host.session === session) {
        this.host.showError(`Queued goal could not be restored: ${formatErrorMessage(error)}`);
      }
    }
    await this.cancelStarted(session);
  }

  private async cancelStarted(session: CoreSession): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (error) {
      if (this.host.session === session) {
        this.host.showError(`Queued goal could not be cancelled: ${formatErrorMessage(error)}`);
      }
    }
  }
}
