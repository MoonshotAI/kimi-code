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
 * prompts and skip convergence entirely. Convergence is a full recompute
 * rather than a delta, so a later mutation retries whatever an earlier
 * failure left stale; a hung participant is cut off by a timeout so the App
 * mutation queue cannot be blocked forever, and failures surface through
 * `log`. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { PLUGIN_SKILL_SOURCE_ID } from '#/session/sessionSkillCatalog/pluginSkillSource';

import {
  ISessionPluginContributionService,
  type SessionPluginContributionChangedEvent,
} from './sessionPluginContribution';

const CONVERGE_TIMEOUT_MS = 30_000;

export class SessionPluginContributionService
  extends Disposable
  implements ISessionPluginContributionService
{
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(
    new AsyncEmitter<SessionPluginContributionChangedEvent>(),
  );
  readonly onDidChange: Event<SessionPluginContributionChangedEvent> = this.changeEmitter.event;

  constructor(
    @ILogService private readonly log: ILogService,
    @IPluginService plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
  ) {
    super();
    this._register(
      plugins.onDidChange((event) => {
        if (event.kind === 'mcp') return;
        event.waitUntil(this.converge());
      }),
    );
  }

  private async converge(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      try {
        await this.skillCatalog.reloadSource(PLUGIN_SKILL_SOURCE_ID);
      } catch (error) {
        this.log.warn(
          `Plugin skill reload failed during convergence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.changeEmitter.fireAsync({}, new AbortController().signal);
    })();
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, CONVERGE_TIMEOUT_MS);
    });
    const result = await Promise.race([work.then(() => 'done' as const), expired]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === 'timeout') {
      this.log.warn(
        'Plugin contribution convergence timed out; the next plugin change retries it',
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
