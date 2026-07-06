/**
 * `contextInjector` domain (L4) — plugin session-start reminder injection.
 *
 * Production equivalent of v1's `agent/injection/plugin-session-start.ts`.
 * Registers a turn-cadence `plugin_session_start` injection with
 * `IAgentContextInjectorService` so enabled plugins' `sessionStart` skills are
 * rendered into the main agent's context once per turn (deduped against
 * replayed history by the context-injector). On the Session skill-catalog
 * sink's `onDidChange`, force-appends a fresh reminder — or a neutralizing
 * reminder when no session start is resolvable but stale guidance may linger —
 * mirroring the `/reload` re-injection flow.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { ILogService } from '#/_base/log';
import { IPluginService } from '#/app/plugin';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
import { ISessionContext } from '#/session/sessionContext';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentSystemReminderService } from '#/agent/systemReminder';

import { IAgentContextInjectorService } from './contextInjector';

const INJECTION_VARIANT = 'plugin_session_start';

export interface IPluginSessionStartInjectorService {
  readonly _serviceBrand: undefined;
}

export const IPluginSessionStartInjectorService: ServiceIdentifier<IPluginSessionStartInjectorService> =
  createDecorator<IPluginSessionStartInjectorService>('pluginSessionStartInjectorService');

export class PluginSessionStartInjectorService
  extends Disposable
  implements IPluginSessionStartInjectorService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService private readonly injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      this.injector.register(INJECTION_VARIANT, () => this.renderReminder(), { cadence: 'turn' }),
    );
    this._register(
      this.skillCatalog.onDidChange(() => {
        void this.appendReminderOnReload();
      }),
    );
  }

  private async renderReminder(): Promise<string | undefined> {
    const sessionStarts = await this.plugins.enabledSessionStarts();
    if (sessionStarts.length === 0) return undefined;
    await this.skillCatalog.ready;
    return renderPluginSessionStartReminder({
      sessionStarts,
      catalog: this.skillCatalog.catalog,
      log: this.log,
      sessionId: this.sessionContext.sessionId,
    });
  }

  private async appendReminderOnReload(): Promise<void> {
    const sessionStarts = await this.plugins.enabledSessionStarts();
    await this.skillCatalog.ready;
    const reminder = renderPluginSessionStartReminder({
      sessionStarts,
      catalog: this.skillCatalog.catalog,
      log: this.log,
      sessionId: this.sessionContext.sessionId,
    });
    if (reminder !== undefined) {
      this.reminders.appendSystemReminder(
        `${reminder}\n\nThis supersedes any earlier plugin_session_start reminder in this session.`,
        { kind: 'injection', variant: INJECTION_VARIANT },
      );
    } else if (shouldNeutralizePluginSessionStart(this.context.get())) {
      this.reminders.appendSystemReminder(
        'There are currently no active plugin session starts. ' +
          'This supersedes any earlier plugin_session_start reminder in this session.',
        { kind: 'injection', variant: INJECTION_VARIANT },
      );
    }
  }
}

export interface RenderPluginSessionStartReminderInput {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly catalog: SkillCatalog | undefined;
  readonly log?: { warn(message: string, payload?: unknown): void };
  readonly sessionId?: string;
}

export function renderPluginSessionStartReminder(
  input: RenderPluginSessionStartReminderInput,
): string | undefined {
  const { sessionStarts, catalog, log, sessionId } = input;
  if (sessionStarts.length === 0) return undefined;
  if (catalog === undefined) return undefined;
  const blocks: string[] = [];
  for (const sessionStart of sessionStarts) {
    const skill = catalog.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
    if (skill === undefined) {
      log?.warn('plugin sessionStart skill not found', {
        pluginId: sessionStart.pluginId,
        skillName: sessionStart.skillName,
      });
      continue;
    }
    blocks.push(
      renderSessionStartBlock(sessionStart, skill, catalog.renderSkillPrompt(skill, '', { sessionId })),
    );
  }
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

/**
 * True when the context may still carry stale plugin guidance — an earlier
 * `<plugin_session_start>` reminder or a compaction summary that may have
 * folded one in — so a neutralizing reminder should replace it.
 */
export function shouldNeutralizePluginSessionStart(
  history: readonly { readonly origin?: { readonly kind: string; readonly variant?: string } }[],
): boolean {
  return history.some((message) => {
    const kind = message.origin?.kind;
    if (kind === 'injection') {
      return message.origin?.variant === INJECTION_VARIANT;
    }
    return kind === 'compaction_summary';
  });
}

function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IPluginSessionStartInjectorService,
  PluginSessionStartInjectorService,
  InstantiationType.Delayed,
  'contextInjector',
);
