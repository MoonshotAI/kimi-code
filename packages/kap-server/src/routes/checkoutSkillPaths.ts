import { ISessionIndex, ISessionSkillCatalog, resumeSessionById, type Scope } from '@moonshot-ai/agent-core-v2';

import { checkoutRelocation, storedSessionWorktree } from '../services/worktrees/sessionWorktreeState';

type SkillPathChooser = (name: string, path: string) => string;

async function skillPathChooser(core: Scope, sessionId: string): Promise<SkillPathChooser | undefined> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  const stored = storedSessionWorktree(summary?.custom);
  const relocation = stored === undefined ? undefined : checkoutRelocation(stored);
  if (relocation === undefined) return undefined;
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) return undefined;
  const catalog = handle.accessor.get(ISessionSkillCatalog);
  await catalog.ready;
  return (name, path) => {
    if (catalog.catalog.getSkill(name, path) !== undefined) return path;
    const moved = relocation(path);
    return catalog.catalog.getSkill(name, moved) === undefined ? path : moved;
  };
}

export async function skillsForCheckout<T extends { readonly name: string; readonly path?: string }>(
  core: Scope,
  sessionId: string,
  skills: readonly T[] | undefined,
): Promise<T[] | undefined> {
  if (skills === undefined) return undefined;
  if (!skills.some((skill) => skill.path !== undefined)) return [...skills];
  const choose = await skillPathChooser(core, sessionId);
  if (choose === undefined) return [...skills];
  return skills.map((skill) => (skill.path === undefined ? skill : { ...skill, path: choose(skill.name, skill.path) }));
}
