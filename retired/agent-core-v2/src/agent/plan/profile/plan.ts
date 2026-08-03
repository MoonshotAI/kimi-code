/**
 * `plan` domain (L4) — builtin `plan` profile contribution.
 *
 * Registers the read-only planning task-agent profile. The profile is
 * self-contained: its `systemPrompt` renderer merges the shared base template
 * with the planning role text at call time, so a child agent no longer inherits
 * the parent's prompt through a runtime overlay.
 *
 * Import-triggered registration: this module is side-effect-imported by
 * `./profile` so loading the `plan` barrel populates the contribution list
 * before `AgentProfileCatalogService` constructs.
 */

import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  renderSystemPrompt,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';

const PLAN_TOOLS = [
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const PLAN_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Before designing your implementation plan, consider whether you fully understand the codebase areas ' +
  'relevant to the task. If not, recommend the parent agent to use the explore agent ' +
  '(subagent_type="explore") to investigate key questions first. In your response, clearly state:\n' +
  '1. What you already know from the information provided\n' +
  '2. What questions remain unanswered that would benefit from explore agent investigation\n' +
  '3. Your implementation plan (either preliminary if questions remain, or final if sufficient context exists)\n\n' +
  'You are a read-only planning agent: you can read and search files (Read, Glob, Grep, ReadMediaFile) ' +
  'and consult the web (WebSearch, FetchURL), but you have no shell and no file-editing tools. ' +
  'Where the general instructions tell you to make changes with tools, that does not apply to you — ' +
  'do not attempt to run commands or modify files. Your deliverable is the plan itself, returned as ' +
  'your final message.';

registerAgentProfile({
  name: 'plan',
  description: 'Read-only implementation planning and architecture design.',
  whenToUse:
    'Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.',
  tools: PLAN_TOOLS,
  systemPrompt: (context) =>
    renderSystemPrompt(PLAN_ROLE, context, { skillActive: skillActiveFor(PLAN_TOOLS) }),
});
