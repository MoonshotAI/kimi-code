import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

export interface EffectiveWorkspaceRoots {
  readonly workDir: string;
  readonly primaryDir?: string;
  readonly additionalDirs: readonly string[];
  readonly followsPrimary: boolean;
}

export function resolveEffectiveWorkspaceRoots(
  session: Pick<ISessionContext, 'workspaceId' | 'cwd'>,
  pinnedCwd: string | undefined,
  workspace: Pick<ISessionWorkspaceInfo, 'primaryByWorkspace' | 'additionalDirs'>,

): EffectiveWorkspaceRoots {
  const primaryDir = workspace.primaryByWorkspace[session.workspaceId];
  const followsPrimary = pinnedCwd === undefined && primaryDir !== undefined;
  const workDir = pinnedCwd ?? primaryDir ?? session.cwd;
  const workDirKey = workspaceRootKey(workDir);
  const seen = new Set([workDirKey]);
  const additionalDirs: string[] = [];
  for (const dir of [primaryDir, ...workspace.additionalDirs]) {
    if (dir === undefined) continue;
    const key = workspaceRootKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    additionalDirs.push(dir);
  }
  return { workDir, primaryDir, additionalDirs, followsPrimary };
}
