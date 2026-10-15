import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { isUnknownCapability } from '#/llm-adapter/contract/capability';
import { type ModelRequester } from '#/llm-adapter/model/model-requester';
import { runWithCredentialRecovery } from '#/llm-adapter/model/credential-recovery';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ILogService } from '#/_base/log/log';
import { extendWorkspaceWithSkillRoots } from '#/tool/path-access';
import type { Runtime } from '#/runtime/runtime';

import { IAgentMediaToolsRegistrar } from './mediaTools';
import { createVideoUploader, registerMediaTools } from './registerMediaTools';
import { ISessionMediaStore } from './sessionMediaStore';

export const mediaRegisteredKeyKey = defineState<string | undefined>(
  'media.registeredKey',
  () => undefined as string | undefined,
);

export class AgentMediaToolsRegistrar extends Service implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;
  private appliedModelKey: string | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IEventBus eventBus: IEventBus,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ILogService private readonly log: ILogService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @ISessionMediaStore private readonly attachmentStore?: ISessionMediaStore,
  ) {
    super();
    this.states.contributeState(mediaRegisteredKeyKey);
    this.refresh();
    this._register(eventBus.subscribe(AgentStatusUpdated, () => this.refresh()));
    this._register(this.runtime.onDidChange(() => this.refresh()));
    this._register(toDisposable(() => this.registration?.dispose()));
  }

  private get registeredKey(): string | undefined {
    return this.states.get(mediaRegisteredKeyKey);
  }

  private set registeredKey(value: string | undefined) {
    this.states.set(mediaRegisteredKeyKey, value);
  }

  private tryResolveModel(alias: string): Model | undefined {
    if (alias === '') return undefined;
    try {
      return this.modelCatalog.get(alias);
    } catch {
      return undefined;
    }
  }

  private refresh(): void {
    const capabilities = this.profile.getModelCapabilities();
    const modelAlias = this.profile.getModel();
    const modelKey = [
      modelAlias,
      String(capabilities.image_in),
      String(capabilities.video_in),
    ].join('|');
    const hasRuntimeFs = this.runtime.isAvailable(['fs']);
    if (
      isUnknownCapability(capabilities) &&
      this.registration !== undefined &&
      (hasRuntimeFs || this.attachmentStore !== undefined)
    ) {
      this.log.debug('media tools registration kept: bound model capabilities are unknown', {
        model: modelAlias,
      });
      return;
    }
    let inspected: Runtime | undefined;
    let runtimeUsable = hasRuntimeFs;
    if (hasRuntimeFs) {
      try {
        inspected = this.runtime.inspect();
      } catch (error) {
        runtimeUsable = false;
        if (
          this.attachmentStore !== undefined &&
          this.registration !== undefined &&
          modelKey === this.appliedModelKey
        ) {
          this.log.debug('media tools registration kept: runtime inspect failed', {
            model: modelAlias,
            error,
          });
          return;
        }
        this.log.debug('media tools: runtime inspect failed; treating the runtime as unavailable', {
          model: modelAlias,
          error,
        });
      }
    }
    if (!runtimeUsable && this.attachmentStore === undefined) {
      const key = [
        modelAlias,
        String(capabilities.image_in),
        String(capabilities.video_in),
        'runtime-unavailable',
      ].join('|');
      if (key === this.registeredKey) return;
      this.registeredKey = key;
      this.appliedModelKey = modelKey;
      if (this.registration !== undefined) {
        this.log.debug('media tools unregistered: runtime unavailable and no attachment store', {
          key,
        });
      }
      this.registration?.dispose();
      this.registration = undefined;
      return;
    }
    const identityKey = inspected === undefined ? 'session-attachments' : [
      inspected.identity.workspaceId,
      inspected.identity.runtimeId,
      inspected.identity.generation,
    ].join('|');
    const model = this.tryResolveModel(modelAlias);
    const key = [
      modelAlias,
      model?.providerType ?? '',
      model?.protocol ?? '',
      String(capabilities.image_in),
      String(capabilities.video_in),
      identityKey,
      inspected?.status,
      inspected?.environment.pathClass,
      String(hasRuntimeFs),
    ].join('|');
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    this.appliedModelKey = modelKey;
    this.registration?.dispose();
    this.log.debug('media tools registration refreshed', { key });
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const runtime = this.runtime;
    const pathClass = inspected?.environment.pathClass;
    let requester: ModelRequester | undefined;
    if (model !== undefined) {
      try {
        requester = this.modelCatalog.getRequester(modelAlias);
      } catch (error) {
        this.log.warn('media tools: failed to resolve model requester; video upload disabled', {
          model: modelAlias,
          error,
        });
        requester = undefined;
      }
    }
    const uploader = createVideoUploader(requester, {
      client: this.telemetry,
      props: {
        model: modelAlias,
        provider_type: model?.providerType ?? model?.protocol,
        protocol: model?.protocol,
      },
    });
    this.registration = registerMediaTools(this.toolRegistry, {
      attachmentStore: this.attachmentStore,
      runtime,
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
      capabilities,
      videoUploader:
        uploader === undefined || requester === undefined
          ? undefined
          : (input, options) =>
              runWithCredentialRecovery(
                requester.model.credentialProvider,
                () => uploader(input, options),
                options?.signal,
              ),
      inlineVideoSupported: model?.protocol !== 'openai' && model?.protocol !== 'openai_responses',
      providerType: model?.providerType,
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
