import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { HOOKS_SECTION, type HookDefConfig } from '../configSection';
import {
  type HookExecutionError,
  IExternalHooksRunnerService,
  type ExternalHooksRunnerTriggerArgs,
} from './externalHooksRunner';
import { blockDecision, indexHooks, runMatchedHooks } from '../internal/matchHooks';
import type { HookRunCallbacks } from '../internal/matchHooks';
import type { HookBlockDecision, HookDef, HookResult } from '../internal/types';

export class ExternalHooksRunnerService extends Disposable implements IExternalHooksRunnerService {
  declare readonly _serviceBrand: undefined;

  private byEvent = new Map<string, HookDef[]>();
  readonly ready: Promise<void>;

  private readonly _onDidReload = this._register(new Emitter<void>());
  readonly onDidReload: Event<void> = this._onDidReload.event;

  private readonly _onDidHookError = this._register(new Emitter<HookExecutionError>());
  readonly onDidHookError: Event<HookExecutionError> = this._onDidHookError.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IPluginService private readonly plugins: IPluginService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService = noopTelemetryService,
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
      return this.triggerInner(event, args).catch((error: unknown): HookResult[] => {
        this.reportFailure(event, undefined, error, args.sessionId);
        return [];
      });
    } catch (error) {
      this.reportFailure(event, undefined, error, args.sessionId);
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
      return this.trigger(event, args).catch((error: unknown): HookResult[] => {
        this.reportFailure(event, undefined, error, args.sessionId);
        return [];
      });
    } catch (error) {
      this.reportFailure(event, undefined, error, args.sessionId);
      return Promise.resolve([]);
    }
  }

  hasHooksFor(event: string): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  private reportFailure(
    event: string,
    hook: HookDef | undefined,
    error: unknown,
    sessionId: string | undefined,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn(`hook execution failed for event ${event}: ${message}`, {
      event,
      sessionId,
      command: hook?.command,
    });
    this._onDidHookError.fire({ event, sessionId, command: hook?.command, message });
  }

  private async triggerInner(
    event: string,
    args: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookResult[]> {
    await this.ready;
    const results = await runMatchedHooks(
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
      {
        onTriggered: this.callbacks.onTriggered,
        onResolved: this.callbacks.onResolved,
        onError: (failedEvent, hook, message) => {
          try {
            this.callbacks.onError?.(failedEvent, hook, message);
          } catch {}
          this.reportFailure(failedEvent, hook, message, args.sessionId);
        },
      },
    );
    if (results.length > 0) {
      this.telemetry.track2('external_hook_resolved', {
        event,
        action: blockDecision(event, results) === undefined ? 'allow' : 'block',
        matched_count: results.length,
        failed_count: results.filter(
          (r) => r.timedOut === true || r.errored === true || (!!r.exitCode && r.exitCode !== 2),
        ).length,
      });
    }
    return results;
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
    this._onDidReload.fire();
  }
}
