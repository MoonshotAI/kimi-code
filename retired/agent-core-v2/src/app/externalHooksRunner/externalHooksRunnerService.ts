/**
 * `externalHooksRunner` domain (L6) — `IExternalHooksRunnerService` impl.
 *
 * Owns the configured-hook lifecycle: builds the event→hooks index from
 * `IConfigService` (`[[hooks]]`) + `IPluginService.enabledHooks()`, reloads it
 * on `plugin.onDidReload`, and dispatches each trigger through the pure
 * `runMatchedHooks`. The App-scope `IHostProcessService` is injected here and
 * threaded down to `runHook`, so hook commands spawn through the shared host
 * process service (cross-platform kill, hidden console on Windows) rather than
 * `node:child_process` directly. Per-call caller facts (`cwd` defaulting to
 * bootstrap cwd, `sessionId`, `signal`, payload) flow in through the args, so
 * this service keeps no per-scope state. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
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

export class ExternalHooksRunnerService extends Disposable implements IExternalHooksRunnerService {
  declare readonly _serviceBrand: undefined;

  private byEvent = new Map<string, HookDef[]>();
  readonly ready: Promise<void>;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IPluginService private readonly plugins: IPluginService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    private readonly callbacks: HookRunCallbacks = {},
  ) {
    super();
    this.ready = this.loadSafe();
    this._register(
      this.plugins.onDidReload(() => {
        void this.reloadSafe();
      }),
    );
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

  private async triggerInner(
    event: string,
    args: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookResult[]> {
    await this.ready;
    return runMatchedHooks(
      this.hostProcess,
      this.byEvent,
      event,
      {
        cwd: args.cwd ?? this.bootstrap.cwd,
        ...args,
      },
      this.callbacks,
    );
  }

  private async loadSafe(): Promise<void> {
    try {
      await this.load();
    } catch {}
  }

  private async reloadSafe(): Promise<void> {
    try {
      await this.load();
    } catch {}
  }

  private async load(): Promise<void> {
    await this.config.ready;
    const configured = this.config.get(HOOKS_SECTION) as readonly HookDefConfig[] | undefined;
    const pluginHooks = await this.plugins.enabledHooks();
    this.byEvent = indexHooks([...(configured ?? []), ...pluginHooks]);
  }
}

registerScopedService(
  LifecycleScope.App,
  IExternalHooksRunnerService,
  ExternalHooksRunnerService,
  InstantiationType.Eager,
  'externalHooksRunner',
);
