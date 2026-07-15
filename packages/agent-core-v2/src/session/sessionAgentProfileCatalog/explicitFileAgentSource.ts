/**
 * `sessionAgentProfileCatalog` domain (L3) — explicit `IAgentProfileSource`
 * producer.
 *
 * Loads the individual agent Markdown files named by runtime options
 * (`--agent-file`), contributing them at priority 40 — the highest source, so
 * an explicitly named file always wins name collisions. Unlike directory
 * sources (which skip invalid files with a warning), a missing or invalid
 * explicit file is fatal: the user named it on the command line, so silently
 * dropping it would mask intent. Bound at Session scope so relative paths
 * resolve against the session workDir.
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentCatalogRuntimeOptions } from '#/app/agentFileCatalog/agentCatalogRuntimeOptions';
import { parseAgentFileText } from '#/app/agentFileCatalog/agentFile';
import { agentProfileFromFile } from '#/app/agentFileCatalog/agentProfileFromFile';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IExplicitFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IExplicitFileAgentSource: ServiceIdentifier<IExplicitFileAgentSource> =
  createDecorator<IExplicitFileAgentSource>('explicitFileAgentSource');

export class ExplicitFileAgentSource implements IExplicitFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'explicit';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.explicit;
  readonly fatal = true;

  constructor(
    @IAgentCatalogRuntimeOptions private readonly runtimeOptions: IAgentCatalogRuntimeOptions,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const files = this.runtimeOptions.explicitFiles ?? [];
    const profiles: AgentProfile[] = [];
    for (const file of files) {
      const filePath = resolveExplicitFile(file, this.workspace.workDir, this.bootstrap.osHomeDir);
      const text = await fs.readFile(filePath, 'utf8');
      profiles.push(
        agentProfileFromFile(parseAgentFileText({ path: filePath, source: 'explicit', text })),
      );
    }
    return { profiles };
  }
}

export function resolveExplicitFile(file: string, workDir: string, osHomeDir: string): string {
  if (file === '~') return osHomeDir;
  if (file.startsWith('~/')) return path.join(osHomeDir, file.slice(2));
  if (path.isAbsolute(file)) return file;
  return path.resolve(workDir, file);
}

registerScopedService(
  LifecycleScope.Session,
  IExplicitFileAgentSource,
  ExplicitFileAgentSource,
  InstantiationType.Eager,
  'sessionAgentProfileCatalog',
);
