/**
 * `agentPlugin` domain — `IAgentPluginService` implementation.
 *
 * Renders session-start skills from `plugin` and `sessionSkillCatalog`, injects
 * them through `contextInjector` and `systemReminder`, and uses `contextMemory`
 * to neutralize stale guidance. The session-start refresh on plugin-source
 * catalog changes fires only for an explicit plugin reload: a mutation-driven
 * reload (install / enable / disable / remove) skips it — the live session
 * keeps the guidance it started with — and instead appends a `plugin_change`
 * system reminder through `systemReminder` (`plugin` `onDidMutate` — never on
 * an explicit reload, whose resumed session would otherwise inherit a stale
 * notice), naming the mutated plugin and telling the model the live session
 * keeps its original prompt and tool set until `/new` or `/reload`.
 * Main-agent-only (v1 parity): the service
 * self-gates on `agentId === 'main'`; Agent scope creation instantiates it for
 * every agent, so other agents construct it as a no-op. Resolves
 * session prompt context through `sessionContext` and reports missing skills
 * through `log`. Bound at Agent scope.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart, PluginMutation } from '#/app/plugin/types';
import { PLUGIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { IAgentPluginService } from './agentPlugin';

const SESSION_START_INJECTION_VARIANT = 'plugin_session_start';

const PLUGIN_CHANGE_INJECTION_VARIANT = 'plugin_change';

const PLUGIN_CHANGE_VERBS: Record<PluginMutation['kind'], string> = {
  install: 'installed',
  enable: 'enabled',
  disable: 'disabled',
  remove: 'removed',
  'mcp-server': 'updated',
};

function renderPluginChangeReminder(mutation: PluginMutation): string {
  return (
    `Plugin "${mutation.id}" was ${PLUGIN_CHANGE_VERBS[mutation.kind]}. ` +
    'This session keeps the prompt and tools it started with; ' +
    'run /new or /reload to apply the change, and tell the user if they expect it now.'
  );
}

const MAIN_AGENT_ID = 'main';

export class AgentPluginService extends Service implements IAgentPluginService {
  declare readonly _serviceBrand: undefined;

  // Count of mutation-driven plugin reloads whose catalog change has not
  // reached this agent yet. `reloadAndNotify` fires `onDidMutate`
  // synchronously within every mutation's `onDidReload`, while the catalog
  // re-scan completes asynchronously, so the count is always positive by the
  // time a mutation-driven catalog change arrives.
  private pendingMutationCatalogChanges = 0;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (scopeContext.agentId !== MAIN_AGENT_ID) return;
    this._register(
      injector.register(
        SESSION_START_INJECTION_VARIANT,
        async ({ injectedPositions }) => {
          if (injectedPositions.length > 0) return undefined;
          return this.renderSessionStartReminder();
        },
      ),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (sourceId !== PLUGIN_SKILL_SOURCE_ID) return;
        if (this.pendingMutationCatalogChanges > 0) {
          // Mutation-driven reload: the live session keeps the session-start
          // guidance it started with — the plugin_change reminder is the only
          // notice it gets. A failed mutation reload produces no catalog
          // change, so a later explicit-reload refresh may be skipped once;
          // that only keeps the frozen guidance longer, which is safe.
          this.pendingMutationCatalogChanges--;
          return;
        }
        void this.appendFreshSessionStartReminder();
      }),
    );
    this._register(
      this.plugins.onDidMutate(({ mutation }) => {
        this.pendingMutationCatalogChanges++;
        this.reminders.appendSystemReminder(renderPluginChangeReminder(mutation), {
          kind: 'injection',
          variant: PLUGIN_CHANGE_INJECTION_VARIANT,
        });
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
  ScopeActivation.OnScopeCreated,
  'agentPlugin',
);
