/**
 * `agentPlugin` domain (L4) — `IAgentPluginService` implementation.
 *
 * Renders enabled plugins' `sessionStart` skills into the main agent's context.
 * The normal injection path mirrors v1: add one reminder while no live
 * `plugin_session_start` injection exists. Reload paths force-append a fresh
 * reminder, or neutralize stale guidance when no session start is active.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { IAgentPluginService } from './agentPlugin';

const SESSION_START_INJECTION_VARIANT = 'plugin_session_start';

export class AgentPluginService extends Disposable implements IAgentPluginService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      injector.register(
        SESSION_START_INJECTION_VARIANT,
        async ({ injectedPositions }) => {
          if (injectedPositions.length > 0) return undefined;
          return this.renderSessionStartReminder();
        },
        { cadence: 'turn' },
      ),
    );
    this._register(
      this.skillCatalog.onDidChange(() => {
        void this.appendFreshSessionStartReminder();
      }),
    );
  }

  private async renderSessionStartReminder(): Promise<string | undefined> {
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

  async appendFreshSessionStartReminder(): Promise<void> {
    const reminder = await this.renderSessionStartReminder();
    if (reminder !== undefined) {
      this.reminders.appendSystemReminder(
        `${reminder}\n\nThis supersedes any earlier plugin_session_start reminder in this session.`,
        { kind: 'injection', variant: SESSION_START_INJECTION_VARIANT },
      );
    } else if (shouldNeutralizePluginSessionStart(this.context.get())) {
      this.reminders.appendSystemReminder(
        'There are currently no active plugin session starts. ' +
          'This supersedes any earlier plugin_session_start reminder in this session.',
        { kind: 'injection', variant: SESSION_START_INJECTION_VARIANT },
      );
    }
  }
}

interface RenderPluginSessionStartReminderInput {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly catalog: SkillCatalog | undefined;
  readonly log?: { warn(message: string, payload?: unknown): void };
  readonly sessionId?: string;
}

function renderPluginSessionStartReminder(
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

function shouldNeutralizePluginSessionStart(
  history: readonly { readonly origin?: { readonly kind: string; readonly variant?: string } }[],
): boolean {
  return history.some((message) => {
    const kind = message.origin?.kind;
    if (kind === 'injection') {
      return message.origin?.variant === SESSION_START_INJECTION_VARIANT;
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
  IAgentPluginService,
  AgentPluginService,
  InstantiationType.Delayed,
  'agentPlugin',
);
