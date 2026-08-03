/**
 * WorkspaceConfig — defines the roots that tools are allowed to access.
 *
 * Injected through each Tool's constructor. Not passed through Runtime:
 * the Runtime keeps a small fixed shape and workspace limits live on
 * the Tool side.
 *
 * Paths should already be canonicalized lexically (absolute + normalized);
 * callers are responsible for normalizing before constructing this config.
 */

export interface WorkspaceConfig {
  /** Primary workspace directory (absolute, canonicalized). */
  readonly workspaceDir: string;
  /** Extra allowed roots (e.g. `--add-dir` CLI flag). */
  readonly additionalDirs: readonly string[];
}
