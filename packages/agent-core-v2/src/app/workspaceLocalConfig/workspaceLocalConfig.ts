/**
 * `workspaceLocalConfig` domain (L2) — project-local workspace config access.
 *
 * Defines the App-scoped `IWorkspaceLocalConfigService` contract for
 * project-local `.kimi-code/local.toml` access. Session domains consume the
 * resolved directory list and never parse or write the TOML document
 * themselves; the local filesystem backend supplies the implementation.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface WorkspaceAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

export interface IWorkspaceLocalConfigService {
  readonly _serviceBrand: undefined;

  readAdditionalDirs(workDir: string): Promise<WorkspaceAdditionalDirsLoadResult>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  appendAdditionalDir(
    workDir: string,
    inputPath: string,
  ): Promise<WorkspaceAdditionalDirsLoadResult>;
}

export const IWorkspaceLocalConfigService: ServiceIdentifier<IWorkspaceLocalConfigService> =
  createDecorator<IWorkspaceLocalConfigService>('workspaceLocalConfigService');
