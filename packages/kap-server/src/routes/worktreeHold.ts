import { IFileService, ISessionIndex, type Scope } from '@moonshot-ai/agent-core-v2';

import { assertPromptFileRefs, assertPromptPathRefs } from '../lib/promptMedia';
import type { PromptItem, PromptSubmission } from '../protocol/rest-prompt';
import type { ActivateSkillRequest, ActivateSkillResult } from '../protocol/rest-skill';
import { holdPromptForWorktree } from '../services/worktrees/heldPrompts';
import { storedSessionWorktree, worktreeHoldsPrompts } from '../services/worktrees/sessionWorktreeState';

async function mayHold(core: Scope, sessionId: string): Promise<boolean> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  const stored = storedSessionWorktree(summary?.custom);
  return stored !== undefined && (worktreeHoldsPrompts(stored) || stored.held_prompt?.failure !== undefined);
}

export async function holdSubmissionForWorktree(
  core: Scope,
  sessionId: string,
  promptId: string,
  body: PromptSubmission,
): Promise<PromptItem | undefined> {
  if (!(await mayHold(core, sessionId))) return undefined;
  await assertPromptFileRefs(body.content, core.accessor.get(IFileService));
  await assertPromptPathRefs(body.content);
  const createdAt = new Date().toISOString();
  const held = await holdPromptForWorktree(
    core,
    sessionId,
    {
      prompt_id: promptId,
      kind: 'prompt',
      created_at: createdAt,
      content: body.content,
      skills: body.skills,
      metadata: body.metadata,
    },
    { route: 'prompts', body: { ...body, prompt_id: promptId } },
  );
  if (!held) return undefined;
  return {
    prompt_id: promptId,
    user_message_id: promptId,
    status: 'queued',
    content: body.content,
    created_at: createdAt,
    metadata: body.metadata,
  };
}

export async function holdSkillActivationForWorktree(
  core: Scope,
  sessionId: string,
  promptId: string,
  skillId: string,
  body: ActivateSkillRequest,
): Promise<ActivateSkillResult | undefined> {
  if (!(await mayHold(core, sessionId))) return undefined;
  const held = await holdPromptForWorktree(
    core,
    sessionId,
    {
      prompt_id: promptId,
      kind: 'skill',
      created_at: new Date().toISOString(),
      content: body.attachments ?? [],
      skill: { name: skillId, path: body.path, args: body.args },
      metadata: body.metadata,
    },
    { route: 'skills', skill_id: skillId, body: { ...body, prompt_id: promptId } },
  );
  return held ? { activated: true, skill_name: skillId, held: true } : undefined;
}
