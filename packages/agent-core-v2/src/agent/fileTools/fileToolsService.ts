/**
 * `fileTools` domain (L4) — `IAgentFileToolsService` implementation.
 *
 * Registers the built-in file tools (Read / Write / Edit / Grep / Glob) into
 * the agent `IAgentToolRegistryService` on construction, wiring each to the session
 * `ISessionAgentFileSystem` (file IO), `ISessionFsService` (workspace search/grep),
 * `ISessionProcessRunner` (rg subprocess for Glob), `IHostEnvironment`
 * (path semantics) and the session workspace. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { ISessionAgentFileSystem, ISessionFsService } from '#/session/agentFs';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ISessionProcessRunner } from '#/session/process';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

import { IAgentFileToolsService } from './fileTools';
import { EditTool } from '#/agent/fileTools/tools/edit';
import { GlobTool } from '#/agent/fileTools/tools/glob';
import { GrepTool } from '#/agent/fileTools/tools/grep';
import { ReadTool } from '#/agent/fileTools/tools/read';
import { WriteTool } from '#/agent/fileTools/tools/write';

export class AgentFileToolsService implements IAgentFileToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @ISessionAgentFileSystem fs: ISessionAgentFileSystem,
    @IHostEnvironment env: IHostEnvironment,
    @ISessionWorkspaceContext workspace: ISessionWorkspaceContext,
    @ISessionFsService fsService: ISessionFsService,
    @ISessionProcessRunner runner: ISessionProcessRunner,
    @ITelemetryService telemetry: ITelemetryService,
  ) {
    const workspaceConfig: WorkspaceConfig = {
      workspaceDir: workspace.workDir,
      additionalDirs: workspace.additionalDirs,
    };
    toolRegistry.register(new ReadTool(fs, env, workspaceConfig));
    toolRegistry.register(new WriteTool(fs, env, workspaceConfig));
    toolRegistry.register(new EditTool(fs, env, workspaceConfig));
    toolRegistry.register(new GrepTool(fsService, env, workspaceConfig));
    toolRegistry.register(new GlobTool(fs, env, runner, workspaceConfig, telemetry));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFileToolsService,
  AgentFileToolsService,
  InstantiationType.Delayed,
  'fileTools',
);
