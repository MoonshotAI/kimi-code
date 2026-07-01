/**
 * `fileTools` domain (L4) — `IAgentFileToolsService` implementation.
 *
 * Registers the built-in file tools (Read / Write / Edit / Grep / Glob) into
 * the agent `IAgentToolRegistryService` on construction, wiring each to the session
 * `ISessionAgentFileSystem` (file IO), `ISessionFsService` (workspace search/grep), `IKaos`
 * (path semantics) and the session workspace. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { ISessionAgentFileSystem, ISessionFsService } from '#/agentFs';
import { IKaos } from '#/kaos';
import { ITelemetryService } from '#/telemetry';
import { IAgentToolRegistryService } from '#/toolRegistry';
import { ISessionWorkspaceContext } from '#/workspaceContext';

import { IAgentFileToolsService } from './fileTools';
import { EditTool } from './tools/edit';
import { GlobTool } from './tools/glob';
import { GrepTool } from './tools/grep';
import { ReadTool } from './tools/read';
import { WriteTool } from './tools/write';

export class AgentFileToolsService implements IAgentFileToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @ISessionAgentFileSystem fs: ISessionAgentFileSystem,
    @IKaos kaos: IKaos,
    @ISessionWorkspaceContext workspace: ISessionWorkspaceContext,
    @ISessionFsService fsService: ISessionFsService,
    @ITelemetryService telemetry: ITelemetryService,
  ) {
    const workspaceConfig: WorkspaceConfig = {
      workspaceDir: workspace.workDir,
      additionalDirs: workspace.additionalDirs,
    };
    toolRegistry.register(new ReadTool(fs, kaos, workspaceConfig));
    toolRegistry.register(new WriteTool(fs, kaos, workspaceConfig));
    toolRegistry.register(new EditTool(fs, kaos, workspaceConfig));
    toolRegistry.register(new GrepTool(fsService, kaos, workspaceConfig));
    toolRegistry.register(new GlobTool(fs, kaos, workspaceConfig, telemetry));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFileToolsService,
  AgentFileToolsService,
  InstantiationType.Delayed,
  'fileTools',
);
