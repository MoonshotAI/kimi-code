import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';

const PLAN_TOOLS = [
  'NotifyUser',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const PLAN_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'If you lack sufficient codebase context, recommend an explore subagent for the remaining questions. Return:\n' +
  '1. What you know\n' +
  '2. Unanswered questions for explore\n' +
  '3. A preliminary plan if questions remain, otherwise a final implementation plan\n\n' +
  'You are read-only: do not run commands or modify files, even when general instructions say to make changes. ' +
  'Return the plan as your final message.';

registerAgentProfile({
  name: 'plan',
  description: 'Read-only implementation planning and architecture design.',
  whenToUse:
    'Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.',
  tools: PLAN_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(PLAN_ROLE, context, {
      skillActive: skillActiveFor(PLAN_TOOLS),
      readOnly: true,
    }),
});
