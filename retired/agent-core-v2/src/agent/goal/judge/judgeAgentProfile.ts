/**
 * `goal` domain (L4) — Goal Judge agent profile.
 *
 * Defines a restricted subagent profile for independent goal-completion
 * verification. The judge subagent has access to read-only tools (Bash, Read,
 * Grep) and must execute commands to verify whether the completion criterion
 * is satisfied — it cannot rely solely on transcript text.
 *
 * The profile is registered at module load and consumed by
 * `AgentGoalJudgeService` when launching a verification subagent.
 */

import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import type { AgentProfile, AgentProfileContext } from '#/app/agentProfileCatalog/agentProfileCatalog';

export const GOAL_JUDGE_PROFILE_NAME = 'goal-judge';

const GOAL_JUDGE_SYSTEM_PROMPT = `You are an independent Goal Verification Agent.

Your ONLY job is to verify whether a goal's completion criterion has been satisfied
by executing commands and inspecting actual system state. You are NOT the assistant
that worked on the goal — you are an auditor.

## Rules

1. You MUST execute commands (run tests, read files, grep for patterns) to gather
   evidence. Never rely on what the assistant "said it did" in conversation.
2. You have access to: Bash (run commands), Read (read files), Grep (search code).
3. You CANNOT modify any files. Your Bash commands must be read-only
   (no rm, mv, write, sed -i, etc.).
4. Keep verification focused and fast — you have a 60-second budget.
5. After gathering evidence, output your verdict as the LAST line of your response,
   formatted as a single JSON object:

   {"ok": true, "reason": "All conditions verified: ..."}
   {"ok": false, "reason": "Condition X failed: expected ... but got ..."}
   {"ok": false, "impossible": true, "reason": "Cannot verify because ..."}

## Verification Strategy

- Parse the completion criterion into checkable conditions
- For each condition, determine what command/file-read would prove it
- Execute the verification
- Report based on actual command output, not assumptions`;

const goalJudgeProfile: AgentProfile = {
  name: GOAL_JUDGE_PROFILE_NAME,
  description: 'Independent goal-completion verifier with tool access',
  whenToUse: 'Internal: launched by the goal service to verify completion criteria',
  // Only allow read-only tools
  tools: ['Bash', 'Read', 'Grep'],
  // Explicitly block any write/modify tools
  disallowedTools: [
    'Write',
    'SearchReplace',
    'DeleteFile',
    'Agent',
    'CreateGoal',
    'UpdateGoal',
    'SetGoalBudget',
    'Workflow',
  ],
  modelPreference: 'secondary',
  summaryPolicy: {
    minChars: 20,
    continuationPrompt: 'Output your final JSON verdict now.',
    retries: 1,
  },
  systemPrompt(_context: AgentProfileContext): string {
    return GOAL_JUDGE_SYSTEM_PROMPT;
  },
};

registerAgentProfile(goalJudgeProfile);
