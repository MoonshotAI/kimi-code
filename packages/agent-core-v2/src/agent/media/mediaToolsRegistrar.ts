/**
 * Media tool production registration — the Agent-scope service that keeps
 * `ReadMediaFile` in the tool registry in sync with the bound model.
 *
 * Media tools cannot ride the module-level `registerAgentToolService(...)`
 * contribution table: its activation runs when the Agent is created, and at
 * that point no model is bound yet — the capabilities are still
 * `UNKNOWN_CAPABILITY`, so a capability gate would permanently skip the
 * tool. Registration instead re-runs whenever the resolved model changes:
 * every profile/model update publishes `agent.status.updated`, and this
 * service re-invokes {@link registerMediaTools} when the model alias or its
 * media capabilities differ from what it last registered (rebinding the
 * video uploader to the new model, and dropping the tool when the model
 * loses media input). The `inlineVideoSupported` flag rides the same
 * refresh: it is derived from the model's protocol because only the OpenAI
 * family drops inline video on the wire — every other protocol that
 * converts `video_url` takes the inline fallback when no upload hook
 * exists.
 *
 * The plain-data state (`registeredKey`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it; `registration` stays an
 * instance field (the live `IDisposable` tool-registration handle, not plain
 * data).
 *
 * Agent scope creation instantiates this service before any `opts.binding`
 * bind runs, so the first `agent.status.updated` is always observed.
 */

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { type ModelRequester } from '#/kosong/model/modelRequester';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { extendWorkspaceWithSkillRoots } from '#/tool/path-access';
import { resolveVisualModel } from '#/session/visual/configSection';
import type { ModelCapability } from '#/kosong/contract/capability';

import { IAgentMediaToolsRegistrar } from './mediaTools';
import { createVideoUploader, registerMediaTools } from './registerMediaTools';

export const mediaRegisteredKeyKey = defineState<string | undefined>(
  'media.registeredKey',
  () => undefined as string | undefined,
);

export class AgentMediaToolsRegistrar extends Service implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IConfigService private readonly appConfig: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {
    super();
    this.states.register(mediaRegisteredKeyKey);
    this.refresh();
    this._register(eventBus.subscribe('agent.status.updated', () => this.refresh()));
    this._register(toDisposable(() => this.registration?.dispose()));
  }

  private get registeredKey(): string | undefined {
    return this.states.get(mediaRegisteredKeyKey);
  }

  private set registeredKey(value: string | undefined) {
    this.states.set(mediaRegisteredKeyKey, value);
  }

  private refresh(): void {
    const callerCapabilities = this.profile.getModelCapabilities();
    const callerModelAlias = this.profile.getModel();

    // Visual-model companion: when configured (and the experiment is on),
    // a vision-capable visual model lets the media tools register even if
    // the caller's model is text-only. The visual model's capabilities and
    // requester are used in that case so the tool's mime / compression
    // decisions match the model that will actually consume the payload.
    // When the visual model is unset, behavior is unchanged.
    const visualRecipe = resolveVisualModel(this.appConfig, this.flags);
    const visualModelAlias = visualRecipe?.model;
    let visualRequester: ModelRequester | undefined;
    let visualModel: Model | undefined;
    if (visualModelAlias !== undefined) {
      try {
        visualRequester = this.modelCatalog.getRequester(visualModelAlias);
        visualModel = visualRequester.model;
      } catch {
        // dangling pointer — the secondary-model-style warning service is
        // responsible for surfacing it; the registrar just falls back to
        // the caller's model.
      }
    }
    const visualCapabilities: ModelCapability | undefined = visualModel?.capabilities;
    const callerHasMedia = callerCapabilities.image_in || callerCapabilities.video_in;
    const visualHasMedia = visualCapabilities !== undefined
      && (visualCapabilities.image_in || visualCapabilities.video_in);
    const useVisual = !callerHasMedia && visualHasMedia;
    const capabilities = useVisual ? visualCapabilities! : callerCapabilities;

    const key = [
      callerModelAlias,
      String(callerCapabilities.image_in),
      String(callerCapabilities.video_in),
      visualModelAlias ?? '',
      String(visualCapabilities?.image_in ?? false),
      String(visualCapabilities?.video_in ?? false),
    ].join('|');
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    this.registration?.dispose();
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const env = this.env;
    const boundModelAlias = useVisual ? visualModelAlias! : callerModelAlias;
    const boundRequester = useVisual ? visualRequester : undefined;
    let requester: ModelRequester | undefined;
    let model: Model | undefined;
    if (boundModelAlias !== '') {
      try {
        requester = boundRequester ?? this.modelCatalog.getRequester(boundModelAlias);
        model = requester.model;
      } catch {
        requester = undefined;
        model = undefined;
      }
    }
    this.registration = registerMediaTools(this.toolRegistry, {
      fs: this.fs,
      env: this.env,
      workspace: {
        get workspaceDir() {
          return workspaceCtx.workDir;
        },
        get additionalDirs() {
          return extendWorkspaceWithSkillRoots(
            { workspaceDir: workspaceCtx.workDir, additionalDirs: workspaceCtx.additionalDirs },
            skillCatalog?.catalog.getSkillRoots() ?? [],
            env.pathClass,
          ).additionalDirs;
        },
      },
      capabilities,
      videoUploader: createVideoUploader(requester, {
        client: this.telemetry,
        props: {
          model: boundModelAlias,
          provider_type: model?.providerType ?? model?.protocol,
          protocol: model?.protocol,
        },
      }),
      inlineVideoSupported: model?.protocol !== 'openai' && model?.protocol !== 'openai_responses',
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
