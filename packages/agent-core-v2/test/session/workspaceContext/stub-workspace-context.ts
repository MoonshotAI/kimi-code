import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export function stubWorkspaceContext(
  workDir: string,
  additionalDirs: readonly string[] = [],
): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs,
    resolve: (rel) => `${workDir}/${rel}`,
    isWithin: () => true,
    assertAllowed: (absPath) => absPath,
  };
}
