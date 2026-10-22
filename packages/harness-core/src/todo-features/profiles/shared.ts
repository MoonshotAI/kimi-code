export const TASK_AGENT_ROLE_PREFIX =
  'You are now running as a subagent. All the `user` messages are sent by the main agent. ' +
  'The main agent cannot see your context, it can only see your last message when you finish the task. ' +
  'You must treat the parent agent as your caller. Do not directly ask the end user questions. ' +
  'If something is unclear, explain the ambiguity in your final summary to the parent agent.';

export function skillActiveFor(tools: readonly string[]): boolean {
  return tools.includes('Skill');
}
