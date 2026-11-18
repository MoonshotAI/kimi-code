import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { extendWorkspaceWithSkillRoots } from '#/tool/path-access';

import { IAgentMediaToolsRegistrar } from './mediaTools';
import { registerMediaTools } from './registerMediaTools';
import { ISessionMediaStore } from './sessionMediaStore';

export const mediaRegisteredKeyKey = defineState<string | undefined>(
  'media.registeredKey',
  () => undefined as string | undefined,
);

export class AgentMediaToolsRegistrar extends Service implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionMediaStore private readonly attachmentStore: ISessionMediaStore,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {
    super();
    this.states.contributeState(mediaRegisteredKeyKey);
    this.refresh();
    this._register(eventBus.subscribe(AgentStatusUpdated, () => this.refresh()));
    this._register(
      dispatcher.hooks.onDidRestore.register('media', async (_ctx, next) => {
        this.refresh();
        await next();
      }),
    );
    this._register({ dispose: () => this.registration?.dispose() });
  }

  private get registeredKey(): string | undefined {
    return this.states.get(mediaRegisteredKeyKey);
  }

  private set registeredKey(value: string | undefined) {
    this.states.set(mediaRegisteredKeyKey, value);
  }

  private refresh(): void {
    const key = this.environment.pathClass;
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    this.registration?.dispose();
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const pathClass = this.environment.pathClass;
    this.registration = registerMediaTools(this.toolRegistry, {
      attachmentStore: this.attachmentStore,
      fs: this.fs,
      environment: this.environment,
      workspace: {
        get workspaceDir() {
          return workspaceCtx.workDir;
        },
        get additionalDirs() {
          return extendWorkspaceWithSkillRoots(
            { workspaceDir: workspaceCtx.workDir, additionalDirs: workspaceCtx.additionalDirs },
            skillCatalog?.catalog.getSkillRoots() ?? [],
            pathClass,
          ).additionalDirs;
        },
      },
      telemetry: this.telemetry,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaToolsRegistrar,
  AgentMediaToolsRegistrar,
  ScopeActivation.OnScopeCreated,
  'media',
);
