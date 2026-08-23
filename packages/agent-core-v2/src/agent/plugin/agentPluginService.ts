import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  IAgentSystemReminderService,
  systemReminderContent,
} from '#/agent/systemReminder/systemReminder';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart, PluginMutation } from '#/app/plugin/types';
import { PLUGIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentPluginService } from './agentPlugin';
import {
  PluginSessionStartEvent,
  pluginSessionStartSnapshotKey,
} from './agentPluginOps';

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

const SUPERSEDES_SUFFIX =
  'This supersedes any earlier plugin_session_start reminder in this session.';

const NO_ACTIVE_SESSION_STARTS =
  `There are currently no active plugin session starts. ${SUPERSEDES_SUFFIX}`;

export const pluginSessionStartRefreshPendingKey = defineState<boolean>(
  'agentPlugin.sessionStartRefreshPending',
  () => false,
);

export class AgentPluginService extends Service implements IAgentPluginService {
  declare readonly _serviceBrand: undefined;
  private readonly warnedMissingSessionStartSkills = new Set<string>();

  private pendingMutationCatalogChanges = 0;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService private readonly injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    super();
    this.states.contributeState(pluginSessionStartSnapshotKey);
    if (scopeContext.agentId !== MAIN_AGENT_ID) return;
    this.states.contributeState(pluginSessionStartRefreshPendingKey);
    this._register(
      injector.register(SESSION_START_INJECTION_VARIANT, (injection) =>
        this.reconcileSessionStartReminder(injection),
      ),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (sourceId !== PLUGIN_SKILL_SOURCE_ID) return;
        if (this.pendingMutationCatalogChanges > 0) {
          this.pendingMutationCatalogChanges--;
          return;
        }
        this.refreshPending = true;
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

  private get refreshPending(): boolean {
    return this.states.get(pluginSessionStartRefreshPendingKey);
  }

  private set refreshPending(value: boolean) {
    this.states.set(pluginSessionStartRefreshPendingKey, value);
  }

  async refreshSessionStart(): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    this.refreshPending = true;
    await this.skillCatalog.ready;
    await this.injector.reconcileWhenIdle(SESSION_START_INJECTION_VARIANT);
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
      warnedSkills: this.warnedMissingSessionStartSkills,
    });
  }

  private async reconcileSessionStartReminder(
    injection: ContextInjectionContext,
  ): Promise<string | undefined> {
    const forceRefresh = this.refreshPending;
    const desired = await this.resolveDesiredSessionStart(injection, forceRefresh);
    this.refreshPending = false;
    const latest = injection.lastInjection;
    if (desired === undefined) {
      if (
        latest === undefined &&
        (!forceRefresh || !shouldNeutralizePluginSessionStart(this.context.get()))
      ) {
        return undefined;
      }
      if (latest !== undefined && systemReminderContent(latest) === NO_ACTIVE_SESSION_STARTS) {
        return undefined;
      }
      return NO_ACTIVE_SESSION_STARTS;
    }
    if (latest === undefined) return desired;
    const rendered = systemReminderContent(latest);
    if (
      !forceRefresh &&
      (rendered === desired.trim() || rendered === `${desired}\n\n${SUPERSEDES_SUFFIX}`.trim())
    ) {
      return undefined;
    }
    return `${desired}\n\n${SUPERSEDES_SUFFIX}`;
  }

  private async resolveDesiredSessionStart(
    injection: ContextInjectionContext,
    forceRefresh: boolean,
  ): Promise<string | undefined> {
    const snapshot = this.states.get(pluginSessionStartSnapshotKey);
    if (!forceRefresh && snapshot.initialized) return snapshot.content;
    if (!forceRefresh && injection.lastInjection !== undefined) {
      const rendered = systemReminderContent(injection.lastInjection);
      if (rendered !== undefined) {
        const content = frozenSessionStartContent(rendered);
        this.recordSessionStartSnapshot(content);
        return content;
      }
    }
    const content = await this.renderSessionStartReminder();
    this.recordSessionStartSnapshot(content);
    return content;
  }

  private recordSessionStartSnapshot(content: string | undefined): void {
    void this.dispatcher.dispatch(
      new PluginSessionStartEvent({
        agentId: this.scopeContext.agentId,
        content: content ?? null,
      }),
    );
  }
}

function frozenSessionStartContent(rendered: string): string | undefined {
  if (rendered === NO_ACTIVE_SESSION_STARTS) return undefined;
  const suffix = `\n\n${SUPERSEDES_SUFFIX}`;
  return rendered.endsWith(suffix) ? rendered.slice(0, -suffix.length) : rendered;
}

interface RenderPluginSessionStartReminderInput {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly catalog: SkillCatalog | undefined;
  readonly log?: { warn(message: string, payload?: unknown): void };
  readonly sessionId?: string;
  readonly warnedSkills: Set<string>;
}

function renderPluginSessionStartReminder(
  input: RenderPluginSessionStartReminderInput,
): string | undefined {
  const { sessionStarts, catalog, log, sessionId, warnedSkills } = input;
  if (sessionStarts.length === 0) return undefined;
  if (catalog === undefined) return undefined;
  const blocks: string[] = [];
  for (const sessionStart of sessionStarts) {
    const skill = catalog.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
    if (skill === undefined) {
      const key = `${sessionStart.pluginId}:${sessionStart.skillName}`;
      if (!warnedSkills.has(key)) {
        warnedSkills.add(key);
        log?.warn('plugin sessionStart skill not found', {
          pluginId: sessionStart.pluginId,
          skillName: sessionStart.skillName,
        });
      }
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
