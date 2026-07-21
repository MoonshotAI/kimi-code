import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export function stubWorkspaceContext(
  workDir: string,
  additionalDirs: readonly string[] = [],
): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs,
    setWorkDir: () => {},
    setAdditionalDirs: () => {},
    resolve: (rel) => `${workDir}/${rel}`,
    isWithin: () => true,
    assertAllowed: (absPath) => absPath,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}
