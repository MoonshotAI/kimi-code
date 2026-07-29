/**
 * `sessionPluginContribution` domain (L3) — `ISessionPluginContributionService`
 * implementation.
 *
 * Owns the Session-side half of plugin-change convergence: every catalog-kind
 * change announced by the App-scope `plugin` service is first folded into the
 * `sessionSkillCatalog` (the plugin source reload) and only then fanned out to
 * the session's Agents, which re-render prompts from the converged catalog and
 * the current plugin system-prompt sections. The plugin mutation awaits this
 * fan-out, so a mutation promise resolves only when every live Agent has
 * rebuilt its prompt. MCP-only changes (`kind: 'mcp'`) cannot alter skills or
 * prompts and skip convergence entirely. Convergences run one at a time per
 * session — a later change queues behind an in-flight one, so the fan-out
 * emitter never interleaves deliveries. Every segment (skill reload, fan-out,
 * the barrier wait itself) is bounded by the same timeout: a wedged
 * participant delays its round (and whatever it blocks drains oldest-first
 * on a later change), but it can never stop the pipeline or block the App
 * mutation queue forever. Convergence is a full recompute rather than a
 * delta, so a later mutation retries whatever an earlier failure left stale,
 * and failures surface through `log`. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { raceOutcome } from '#/_base/utils/promise';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { PLUGIN_SKILL_SOURCE_ID } from '#/session/sessionSkillCatalog/pluginSkillSource';

import {
  ISessionPluginContributionService,
  PLUGIN_CONVERGENCE_TIMEOUT_MS,
  type SessionPluginContributionChangedEvent,
} from './sessionPluginContribution';

export class SessionPluginContributionService
  extends Disposable
  implements ISessionPluginContributionService
{
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(
    new AsyncEmitter<SessionPluginContributionChangedEvent>(),
  );
  readonly onDidChange: Event<SessionPluginContributionChangedEvent> = this.changeEmitter.event;
  private convergeTail: Promise<void> = Promise.resolve();

  constructor(
    @ILogService private readonly log: ILogService,
    @IPluginService plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
  ) {
    super();
    this._register(
      plugins.onDidChange((event) => {
        if (event.kind === 'mcp') return;
        event.waitUntil(this.awaitConverge());
      }),
    );
  }

  settled(): Promise<void> {
    return this.convergeTail;
  }

  private awaitConverge(): Promise<void> {
    const run = this.convergeTail.then(() => this.converge());
    this.convergeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return raceOutcome(run, PLUGIN_CONVERGENCE_TIMEOUT_MS).then((result) => {
      if (result === 'timeout') {
        this.log.warn(
          'Plugin contribution convergence timed out; a later plugin change retries it',
        );
      }
    });
  }

  private async converge(): Promise<void> {
    const reloaded = await raceOutcome(
      (async () => {
        try {
          await this.skillCatalog.reloadSource(PLUGIN_SKILL_SOURCE_ID);
        } catch (error) {
          this.log.warn(
            `Plugin skill reload failed during convergence: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })(),
      PLUGIN_CONVERGENCE_TIMEOUT_MS,
    );
    if (reloaded === 'timeout') {
      this.log.warn(
        'Plugin skill reload timed out during convergence; continuing with the previous catalog',
      );
    }
    const fannedOut = await raceOutcome(
      this.changeEmitter.fireAsync({}, new AbortController().signal),
      PLUGIN_CONVERGENCE_TIMEOUT_MS,
    );
    if (fannedOut === 'timeout') {
      this.log.warn(
        'Plugin contribution fan-out timed out; blocked participants are delivered on later changes',
      );
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionPluginContributionService,
  SessionPluginContributionService,
  ScopeActivation.OnScopeCreated,
  'sessionPluginContribution',
);
