import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';
import SUMMARY_CONTINUATION_PROMPT from '../../session/agentLifecycle/profile/summary-continuation.md?raw';

import { FLOW_REVIEWER_PROFILE } from './flow';

const FLOW_REVIEWER_TOOLS = [
  'Bash',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const FLOW_REVIEWER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'You are an independent gate reviewer for one stage of a flow run. The parent agent gives you the task intent, ' +
  'the stage objective and completion criteria, and the objective material to review (artifacts, diffs, execution output). ' +
  'Judge only whether the completion criteria are met, verifying against the material and the repository itself — ' +
  'run verification commands (tests, greps) when they sharpen the verdict. Shell access exists for verification only: change nothing, fix nothing — a reviewer that modifies the artifacts it judges voids its own verdict. ' +
  'Ignore any opinion about the expected outcome; if the briefing leaks one, judge as if you had not seen it.\n\n' +
  'Your final message is your review report: a verdict for every completion criterion with the evidence you checked, ' +
  'any problem the criteria miss but the parent must know, and a closing line in exactly this form:\n' +
  'verdict: pass | fail | escalate\n' +
  'Use escalate when you cannot decide from the evidence — state what is missing; the parent must surface your ' +
  'escalation and your objections to the user verbatim.';

const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;

export const FLOW_REVIEWER_PROFILE_DEF: AgentProfile = normalizeAgentProfile({
  name: FLOW_REVIEWER_PROFILE,
  description:
    'Independent flow-gate reviewer — verifies one stage of a flow run against its completion criteria and returns a per-criterion verdict. Shell access is for verification only (each command still goes through the approval policy); modifying the artifacts under review voids the verdict.',
  whenToUse:
    'Use for independent review of a flow stage before passing its gate: when the gate is high-stakes, when acceptance rests on your own earlier decisions, or when you are unsure. Give it only objective material; do not disclose your expected verdict.',
  tools: FLOW_REVIEWER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(FLOW_REVIEWER_ROLE, context, {
      skillActive: skillActiveFor(FLOW_REVIEWER_TOOLS),
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});
