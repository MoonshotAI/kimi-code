/**
 * `agentPlugin` domain — `IAgentPluginService` implementation.
 *
 * Renders session-start skills from `plugin` and `sessionSkillCatalog` as a
 * pure state channel through `contextInjector`: the provider re-renders the
 * current session-start set whenever it is missing from the conversation
 * (compaction recovery) or when the plugin skill catalog changed (a dirty
 * flag forces one supersedes/neutralize render at the next boundary). Uses
 * `contextMemory` to detect stale guidance worth neutralizing. Main-agent-only
 * (v1 parity): the service self-gates on `agentId === 'main'`; Agent scope
 * creation instantiates it for every agent, so other agents construct it as a
 * no-op. Resolves session prompt context through `sessionContext` and reports
 * missing skills through `log`. The plain-data dirty flag is registered into
 * `agentState` (`IAgentStateService`). Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import { PLUGIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { IAgentPluginService } from './agentPlugin';

const SESSION_START_INJECTION_VARIANT = 'plugin_session_start';

const MAIN_AGENT_ID = 'main';

const SUPERSEDES_SUFFIX =
  'This supersedes any earlier plugin_session_start reminder in this session.';

export const pluginSessionStartDirtyKey = defineState<boolean>(
  'agentPlugin.sessionStartDirty',
  () => false,
);

export class AgentPluginService extends Disposable implements IAgentPluginService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    if (scopeContext.agentId !== MAIN_AGENT_ID) return;
    this.states.register(pluginSessionStartDirtyKey);
    this._register(
      injector.register(SESSION_START_INJECTION_VARIANT, async ({ injectedPositions }) => {
        if (this.dirty) {
          this.dirty = false;
          return this.renderSupersedingReminder();
        }
        if (injectedPositions.length > 0) return undefined;
        return this.renderSessionStartReminder();
      }),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (sourceId === PLUGIN_SKILL_SOURCE_ID) {
          this.dirty = true;
        }
      }),
    );
  }

  private get dirty(): boolean {
    return this.states.get(pluginSessionStartDirtyKey);
  }

  private set dirty(value: boolean) {
    this.states.set(pluginSessionStartDirtyKey, value);
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

  private async renderSupersedingReminder(): Promise<string | undefined> {
    const reminder = await this.renderSessionStartReminder();
    if (reminder !== undefined) {
      return `${reminder}\n\n${SUPERSEDES_SUFFIX}`;
    }
    if (shouldNeutralizePluginSessionStart(this.context.get())) {
      return `There are currently no active plugin session starts. ${SUPERSEDES_SUFFIX}`;
    }
    return undefined;
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
