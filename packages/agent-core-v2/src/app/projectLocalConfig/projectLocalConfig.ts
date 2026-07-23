/**
 * `projectLocalConfig` domain (L2) — project-local config access.
 *
 * Defines the App-scoped `IProjectLocalConfigService` contract for
 * project-local `.kimi-code/local.toml` access. The service works purely by
 * path: it discovers the project root (the nearest `.git` ancestor) from a
 * working directory and reads/writes the project-local TOML there — it never
 * touches the workspace catalog or a `workspaceId`. Session domains consume
 * the resolved directory list and never parse or write the TOML document
 * themselves; the local filesystem backend supplies the implementation.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  appendAdditionalDir(
    workDir: string,
    inputPath: string,
  ): Promise<ProjectAdditionalDirsLoadResult>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
