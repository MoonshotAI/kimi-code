/**
 * `externalHooksRunner` domain — `IExternalHooksRunnerService` impl.
 *
 * Owns the configured-hook lifecycle: builds the event→hooks index from
 * `IConfigService` (`[[hooks]]`) + `IPluginService.enabledHooks()`, reloads it
 * on plugin reload and on config change (the interactive TUI can (re)load
 * `config.toml` into the layered config after app-scope construction, so the
 * index must be rebuilt or late `[[hooks]]` would silently never fire, #2779),
 * and dispatches each trigger through the pure
 * `runMatchedHooks`. The App-scope `IHostProcessService` is injected here and
 * threaded down to `runHook`, so hook commands spawn through the shared host
 * process service (cross-platform kill, hidden console on Windows) rather than
 * `node:child_process` directly. Per-call caller facts (`cwd` defaulting to
 * bootstrap cwd, `sessionId`, `signal`, payload) flow in through the args, so
 * this service keeps no per-scope state; the one payload field it contributes
 * itself is `clientType` (the host platform from bootstrap client identity),
 * merged under the caller's `inputData`. Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { HOOKS_SECTION, type HookDefConfig } from '#/agent/externalHooks/configSection';
import type { HookBlockDecision, HookDef, HookResult } from '#/agent/externalHooks/types';
import { IHostProcessService } from '#/os/interface/hostProcess';

import {
  IExternalHooksRunnerService,
  type ExternalHooksRunnerTriggerArgs,
} from './externalHooksRunner';
import { blockDecision, indexHooks, runMatchedHooks } from './runner';
import type { HookRunCallbacks } from './runner';

// NOTE: stays Disposable — its own 'config' collides with the Fiber
export class ExternalHooksRunnerService extends Disposable implements IExternalHooksRunnerService {
  declare readonly _serviceBrand: undefined;

  private byEvent = new Map<string, HookDef[]>();
  readonly ready: Promise<void>;
  // Serializes index rebuilds so a trigger that lands right after a config
  // change awaits the newest index instead of reading the stale one.
  private reloadChain: Promise<void>;

  private readonly _onDidReload = this._register(new Emitter<void>());
  readonly onDidReload: Event<void> = this._onDidReload.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IPluginService private readonly plugins: IPluginService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    private readonly callbacks: HookRunCallbacks = {},
  ) {
    super();
    this.ready = this.loadSafe();
    this.reloadChain = Promise.resolve();
    this._register(
      this.plugins.onDidReload(() => {
        this.queueReload();
      }),
    );
    // Rebuild the hook index when the config changes, not just on plugin
    // reload: the user config file (`config.toml`) can be (re)loaded into the
    // layered config service after this runner's initial `loadSafe()`, and in
    // the interactive TUI `[[hooks]]` may arrive late. The member check keeps
    // the subscription a no-op against partial `IConfigService` stubs.
    if (this.config.onDidChangeConfiguration !== undefined) {
      this._register(
        this.config.onDidChangeConfiguration(() => {
          this.queueReload();
        }),
      );
    }
  }

  get summary(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [event, hooks] of this.byEvent.entries()) {
      result[event] = hooks.length;
    }
    return result;
  }

  trigger(event: string, args: ExternalHooksRunnerTriggerArgs = {}): Promise<HookResult[]> {
    try {
      return this.triggerInner(event, args).catch((): HookResult[] => []);
    } catch {
      return Promise.resolve([]);
    }
  }

  async triggerBlock(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
  ): Promise<HookBlockDecision | undefined> {
    return blockDecision(event, await this.trigger(event, args));
  }

  fireAndForgetTrigger(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
  ): Promise<HookResult[]> {
    try {
      return this.trigger(event, args).catch((): HookResult[] => []);
    } catch {
      return Promise.resolve([]);
    }
  }

  hasHooksFor(event: string): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  private async triggerInner(
    event: string,
    args: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookResult[]> {
    await this.ready;
    await this.reloadChain;
    return runMatchedHooks(
      this.hostProcess,
      this.byEvent,
      event,
      {
        cwd: args.cwd ?? this.bootstrap.cwd,
        ...args,
        inputData: {
          clientType: this.bootstrap.clientIdentity.platform,
          ...args.inputData,
        },
      },
      this.callbacks,
    );
  }

  private async loadSafe(): Promise<void> {
    try {
      await this.load();
    } catch {}
  }

  private queueReload(): void {
    this.reloadChain = this.reloadChain.then(() => this.loadSafe());
  }

  private async load(): Promise<void> {
    await this.config.ready;
    const configured = this.config.get(HOOKS_SECTION) as readonly HookDefConfig[] | undefined;
    const pluginHooks = await this.plugins.enabledHooks();
    this.byEvent = indexHooks([...(configured ?? []), ...pluginHooks]);
    this._onDidReload.fire();
  }
}

registerScopedService(
  LifecycleScope.App,
  IExternalHooksRunnerService,
  ExternalHooksRunnerService,
  ScopeActivation.OnScopeCreated,
  'externalHooksRunner',
);
