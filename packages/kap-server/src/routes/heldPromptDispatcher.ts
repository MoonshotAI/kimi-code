import { ISessionSkillCatalog, type Scope } from '@moonshot-ai/agent-core-v2';

import { promptSubmissionSchema } from '../protocol/rest-prompt';
import { activateSkillRequestSchema } from '../protocol/rest-skill';
import type { HeldPromptDispatcher } from '../services/worktrees/sessionWorktreeService';
import {
  mapHeldSkillPaths,
  type CheckoutRelocation,
  type HeldPromptRequest,
} from '../services/worktrees/sessionWorktreeState';
import { runPromptSubmission } from './prompts';
import { resolveActivatedSession, runSkillActivation } from './skills';

async function requestForCheckout(
  core: Scope,
  sessionId: string,
  request: HeldPromptRequest,
  relocation: CheckoutRelocation | undefined,
): Promise<HeldPromptRequest> {
  if (relocation === undefined) return request;
  const resolved = await resolveActivatedSession(core, sessionId, '');
  if ('envelope' in resolved) return request;
  const catalog = resolved.handle.accessor.get(ISessionSkillCatalog);
  await catalog.ready;
  return mapHeldSkillPaths(request, (name, path) => {
    if (catalog.catalog.getSkill(name, path) !== undefined) return path;
    const moved = relocation(path);
    return catalog.catalog.getSkill(name, moved) === undefined ? path : moved;
  });
}

export function heldPromptDispatcher(core: Scope): HeldPromptDispatcher {
  return async (sessionId, held, stored, relocation) => {
    const request = await requestForCheckout(core, sessionId, stored, relocation);
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
