/**
 * `projectLocalConfig` domain (L2) — project-local config access.
 *
 * Defines the App-scoped `IProjectLocalConfigService` contract for
 * project-local `.kimi-code/local.toml` access. The service works purely by
 * path: it discovers the project root (the nearest `.git` ancestor) from a
 * working directory and reads/writes the project-local TOML there — it never
 * touches the workspace catalog or a `workspaceId`. Session domains consume
 * the resolved directory list and the per-subagent model/effort bindings
 * (`[subagent.<type>]` / `[subagent-slot.<name>]`) and never parse or write
 * the TOML document themselves; the local filesystem backend supplies the
 * implementation. A binding with `inherit: true` is an explicit user choice
 * to keep parent inheritance — recorded so the spawn path does not re-ask on
 * every spawn. Binding writes preserve unrelated TOML content; a read
 * returning `undefined` means the entry was never configured.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

export interface SubagentBinding {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly inherit?: boolean;
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  appendAdditionalDir(
    workDir: string,
    inputPath: string,
  ): Promise<ProjectAdditionalDirsLoadResult>;
  readSubagentBinding(workDir: string, agentType: string): Promise<SubagentBinding | undefined>;
  writeSubagentBinding(
    workDir: string,
    agentType: string,
    binding: SubagentBinding | undefined,
  ): Promise<{ readonly configPath: string }>;
  readSubagentSlotBinding(workDir: string, slot: string): Promise<SubagentBinding | undefined>;
  writeSubagentSlotBinding(
    workDir: string,
    slot: string,
    binding: SubagentBinding | undefined,
  ): Promise<{ readonly configPath: string }>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
