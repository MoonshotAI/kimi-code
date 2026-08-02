/**
 * Agent replay trimming — local port of the retired `agent-core/agent/replay`
 * turn-boundary logic. Replay records describe the message/compaction/goal
 * history of a resumed agent; `limitAgentReplayByTurns` keeps only the most
 * recent N user turns so a resume doesn't replay the whole run.
 *
 * The record shape is intentionally structural (mirrors the agent-core wire
 * `ContextMessage` with an `origin` discriminator); the SDK doesn't need the
 * full agent-core type system to trim replays.
 */

/** The message-origin discriminator that decides whether a record starts a
 *  user turn (typed prompt / `!` input / user slash) or continues one. */
export type ReplayMessageOrigin =
  | { readonly kind: 'user' }
  | { readonly kind: 'skill_activation'; readonly trigger: 'user-slash' | 'agent' }
  | { readonly kind: 'plugin_command'; readonly trigger: 'user-slash' | 'agent' }
  | { readonly kind: 'shell_command'; readonly phase: 'input' | 'output' }
  | { readonly kind: 'background_task' }
  | { readonly kind: 'compaction_summary' }
  | { readonly kind: 'cron_job' }
  | { readonly kind: 'cron_missed' }
  | { readonly kind: 'hook_result' }
  | { readonly kind: 'injection' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'system_trigger'; readonly name: string };

/** A replay message record (the `type: 'message'` payload). */
export interface ReplayMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly origin?: ReplayMessageOrigin | undefined;
  readonly content: unknown;
}

/** One replayed agent history record. */
export type AgentReplayRecord = {
  readonly time: number;
  readonly type: 'message';
  readonly message: ReplayMessage;
};

/**
 * User-turn boundary detection over replay records. A record starts a new user
 * turn when it is a user-role message from an actual user action; system-
 * originated user messages (compaction, cron, hooks, injections, retries)
 * continue the current turn — except `goal_continuation` prompts, which the
 * goal driver fires once per goal turn.
 */
export function isAgentReplayUserTurnRecord(record: AgentReplayRecord): boolean {
  if (record.type !== 'message') return false;
  const { message } = record;
  if (message.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return message.origin.trigger === 'user-slash';
    case 'shell_command':
      return message.origin.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'retry':
      return false;
    case 'system_trigger':
      return message.origin.name === 'goal_continuation';
  }
}

/** Keep only the most recent `maxTurns` user turns of a replay. `undefined`
 *  keeps the full replay; `0` or a negative value returns an empty replay.
 *
 *  The parameter is structural (`unknown` records) so hosts can pass the
 *  agent-core-shaped replay (which the SDK mirrors loosely) without a full
 *  type-system dependency; only the `message.role` / `message.origin` fields
 *  are read. */
export function limitAgentReplayByTurns(
  records: readonly unknown[],
  maxTurns?: number,
): readonly unknown[] {
  if (maxTurns === undefined) return records;
  if (maxTurns <= 0) return [];
  const turnStarts = records.flatMap((record, index) =>
    isAgentReplayUserTurnRecord(record as AgentReplayRecord) ? [index] : [],
  );
  if (turnStarts.length <= maxTurns) return records;
  return records.slice(turnStarts[turnStarts.length - maxTurns]);
}
