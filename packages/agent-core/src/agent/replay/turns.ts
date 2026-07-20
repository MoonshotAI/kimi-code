import type { AgentReplayRecord } from '../../rpc/resumed';

/**
 * User-turn boundary detection over an agent's replay records.
 *
 * A record starts a new user turn when it is a user-role message that came
 * from an actual user action — a typed prompt, a user-invoked skill/plugin
 * slash command, or a `!` shell command's input line. System-originated user
 * messages (compaction summaries, cron fires, hook results, retries, goal
 * reminders, background-task results, injections) continue the current turn
 * instead — with one exception: `goal_continuation` prompts. The goal driver
 * fires one synthetic continuation prompt per goal turn (see
 * agent/turn/index.ts), and the goal system itself counts those as turns, so
 * replay trimming treats them as turn boundaries; otherwise a 100-round goal
 * would count as a single user turn and resume would replay the entire run.
 *
 * Source of truth for turn-boundary detection; the TUI mirrors this through
 * the SDK re-export instead of keeping its own predicate.
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
      return message.origin.trigger === 'user-slash';
    case 'plugin_command':
      return message.origin.trigger === 'user-slash';
    case 'shell_command':
      // A `!` command's input is a user-turn anchor; its output is not.
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
      // The goal driver fires one synthetic continuation prompt per goal turn
      // (agent/turn/index.ts GOAL_CONTINUATION_ORIGIN) — real rounds of work
      // the goal system itself counts as turns. All other system triggers are
      // reminders that continue the current turn.
      return message.origin.name === 'goal_continuation';
  }
}

/**
 * Keep only the most recent `maxTurns` user turns of a replay. `undefined`
 * keeps the full replay; `0` or negative returns an empty replay.
 */
export function limitAgentReplayByTurns(
  records: readonly AgentReplayRecord[],
  maxTurns?: number,
): readonly AgentReplayRecord[] {
  if (maxTurns === undefined) return records;
  if (maxTurns <= 0) return [];
  const turnStarts = records.flatMap((record, index) =>
    isAgentReplayUserTurnRecord(record) ? [index] : [],
  );
  if (turnStarts.length <= maxTurns) return records;
  return records.slice(turnStarts[turnStarts.length - maxTurns]);
}
