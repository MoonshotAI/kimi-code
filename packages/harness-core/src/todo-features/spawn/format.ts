export type SubagentStopReason =
  | 'completed'
  | 'max_steps'
  | 'no_final_message'
  | 'cancelled'
  | 'stopped'
  | 'error';

export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';

const RESUME_NEXT_STEP =
  'next_step: Resume to continue where it stopped, or take over the task yourself; if neither works, report the failure to the user.';

const NEXT_STEP_BY_REASON: Readonly<Record<SubagentStopReason, string | undefined>> = {
  completed: undefined,
  cancelled: 'next_step: The user stopped this subagent. Do not restart it unless the user asks.',
  max_steps: RESUME_NEXT_STEP,
  no_final_message: RESUME_NEXT_STEP,
  stopped: RESUME_NEXT_STEP,
  error: RESUME_NEXT_STEP,
};

export function nextStep(reason: SubagentStopReason): string | undefined {
  return NEXT_STEP_BY_REASON[reason];
}

export function resumeHint(agentId: string, prompt: string): string {
  return `resume_hint: Continue with Agent(resume="${agentId}", prompt="${prompt}"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`;
}

export interface SubagentResultHandle {
  readonly agentId: string;
  readonly profileName: string;
}

export function formatForegroundSuccess(handle: SubagentResultHandle, summary: string): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: completed',
    'stop_reason: completed',
    '',
    '[summary]',
    summary,
    '',
    resumeHint(handle.agentId, '...'),
  ];
  return lines.join('\n');
}

export function formatForegroundFailure(
  handle: SubagentResultHandle,
  message: string,
  reason: SubagentStopReason,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: failed',
    `stop_reason: ${reason}`,
    '',
    `subagent error: ${message}`,
  ];
  if (reason !== 'cancelled') lines.push(resumeHint(handle.agentId, 'continue'));
  const next = nextStep(reason);
  if (next !== undefined) lines.push(next);
  return lines.join('\n');
}

export function formatBackgroundAck(
  taskId: string,
  handle: SubagentResultHandle,
  description: string | undefined,
): string {
  const lines = [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'automatic_notification: true',
  ];
  if (description !== undefined && description.length > 0) {
    lines.push('', `description: ${description}`);
  }
  lines.push(
    '',
    'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or sleep on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)',
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}").`,
  );
  return lines.join('\n');
}
