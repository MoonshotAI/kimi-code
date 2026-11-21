import type { ISessionWorkdirContext } from '#/session/workdirContext/workdirContext';

export function stubWorkspaceContext(
  workDir: string,
  additionalDirs: readonly string[] = [],
): ISessionWorkdirContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs,
    resolve: (rel) => `${workDir}/${rel}`,
    isWithin: () => true,
    assertAllowed: (absPath) => absPath,
    setWorkDir: () => {},
  };
}
