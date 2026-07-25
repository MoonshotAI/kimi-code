/**
 * Media tool production registration — the Eager Agent-scope service that
 * keeps `ReadMediaFile` in the tool registry in sync with the bound model.
 *
 * Media tools cannot ride the module-level `registerTool(...)` contribution
 * table: its `when` predicates run once, when the Agent's tool registry is
 * constructed, and at that point no model is bound yet — the capabilities are
 * still `UNKNOWN_CAPABILITY`, so a capability gate would permanently skip the
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
 * `AgentLifecycleService.create` force-instantiates this service right after
 * the builtin-tools registrar, before any `opts.binding` bind runs, so the
 * first `agent.status.updated` is always observed.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
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

import { IAgentMediaToolsRegistrar } from './mediaTools';
import { createVideoUploader, registerMediaTools } from './registerMediaTools';

export class AgentMediaToolsRegistrar extends Disposable implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;
  private registeredKey: string | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IEventBus eventBus: IEventBus,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {
    super();
    this.refresh();
    this._register(eventBus.subscribe('agent.status.updated', () => this.refresh()));
    this._register(toDisposable(() => this.registration?.dispose()));
  }

  private refresh(): void {
    const capabilities = this.profile.getModelCapabilities();
    const key = [
      this.profile.getModel(),
      String(capabilities.image_in),
      String(capabilities.video_in),
    ].join('|');
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    this.registration?.dispose();
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const env = this.env;
    const modelAlias = this.profile.getModel();
    let requester: ModelRequester | undefined;
    let model: Model | undefined;
    if (modelAlias !== '') {
      requester = this.modelCatalog.getRequester(modelAlias);
      model = requester.model;
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
          model: modelAlias,
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
  InstantiationType.Eager,
  'media',
);
