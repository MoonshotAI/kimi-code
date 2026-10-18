import type { PromptOrigin } from '@moonshot-ai/agent-core-v2';

export function isUserSubmittedTurnOrigin(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined) return false;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash';
    case 'shell_command':
      return origin.phase === 'input';
    case 'injection':
    case 'compaction_summary':
    case 'system_trigger':
    case 'task':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'retry':
      return false;
  }
}
