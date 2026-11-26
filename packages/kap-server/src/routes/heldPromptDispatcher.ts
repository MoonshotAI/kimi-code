import type { Scope } from '@moonshot-ai/agent-core-v2';

import { promptSubmissionSchema } from '../protocol/rest-prompt';
import { activateSkillRequestSchema } from '../protocol/rest-skill';
import type { HeldPromptDispatcher } from '../services/worktrees/sessionWorktreeService';
import { runPromptSubmission } from './prompts';
import { runSkillActivation } from './skills';

export function heldPromptDispatcher(core: Scope): HeldPromptDispatcher {
  return async (sessionId, held, request) => {
    if (request.route === 'prompts') {
      await runPromptSubmission(core, sessionId, promptSubmissionSchema.parse(request.body), held.prompt_id, false);
      return;
    }
    await runSkillActivation(
      core,
      sessionId,
      request.skill_id,
      activateSkillRequestSchema.parse(request.body),
      held.prompt_id,
      { requestId: held.prompt_id },
    );
  };
}
