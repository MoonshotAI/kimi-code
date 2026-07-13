import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

/**
 * Builds a minimal `ISessionWorkspaceContext` stub for file-tool unit tests.
 *
 * The file tools only read `workDir` / `additionalDirs`; the remaining members
 * are no-op stubs so tests can construct tools without standing up a full
 * session scope.
 */
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
