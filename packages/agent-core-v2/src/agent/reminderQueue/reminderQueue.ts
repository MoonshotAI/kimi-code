import { createDecorator } from '#/_base/di/instantiation';

export interface OnceReminderInput {
  /** Injection variant stamped on the delivered message's origin. */
  readonly variant: string;
  /** Reminder body; wrapped into `<system-reminder>` by the write head. */
  readonly content: string;
  /** Optional provenance link to the prompt this reminder belongs to. */
  readonly ownerPromptId?: string;
}

/**
 * Exactly-once channel for past-tense reminder events ("guaranteed delivery,
 * then forget"). Enqueued entries persist in the agent's wire journal and are
 * delivered FIFO by the unified boundary scheduler (`contextInjector`): on
 * `turn.started`, on `onWillBeginStep`, after compaction, and on restore
 * (pending entries are drained before the loop resumes). After delivery the
 * queue loses all interest in the message — compaction or undo removing it
 * later never triggers a re-send.
 */
export interface IAgentReminderQueueService {
  readonly _serviceBrand: undefined;

  /** Persist a pending entry; returns its id. */
  enqueue(input: OnceReminderInput): string;

  /**
   * Deliver every pending entry in FIFO order, marking each delivered.
   * Synchronous; idempotent across concurrent or repeated calls — an entry
   * whose reminder already sits at the conversation tail (crash between
   * append and delivered-record) is reconciled without a duplicate append.
   */
  drain(): void;
}

export const IAgentReminderQueueService = createDecorator<IAgentReminderQueueService>(
  'agentReminderQueueService',
);
