/**
 * `agentPlugin` domain — `IAgentPluginService` implementation.
 *
 * Renders session-start skills from `plugin` and `sessionSkillCatalog`, injects
 * them through `contextInjector` and uses `contextMemory` to neutralize stale
 * guidance. Main-agent-only (v1 parity): the service
 * self-gates on `agentId === 'main'`; Agent scope creation instantiates it for
 * every agent, so other agents construct it as a no-op. Resolves
 * session prompt context through `sessionContext` and reports missing skills
 * through `log`. Persists the conversation-time rendered baseline through
 * `wire`, while catalog revisions remain world-time state. Bound at Agent
 * scope.
 */

import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import { PLUGIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IWireService } from '#/wire/wire';

import { IAgentPluginService } from './agentPlugin';
import {
  AgentPluginModel,
  setPluginSessionStartBaseline,
} from './agentPluginOps';

const SESSION_START_INJECTION_VARIANT = 'plugin_session_start';
const SESSION_START_SUPERSEDED_NOTE =
  'This supersedes any earlier plugin_session_start reminder in this session.';
const SESSION_START_INACTIVE_REMINDER =
  'There are currently no active plugin session starts. ' + SESSION_START_SUPERSEDED_NOTE;

const MAIN_AGENT_ID = 'main';

export class AgentPluginService extends Disposable implements IAgentPluginService {
  declare readonly _serviceBrand: undefined;

  private operationTail: Promise<void> = Promise.resolve();
  private catalogRevision = 0;
  private renderedCatalogRevision = -1;
  private renderedSessionStartReminder: string | undefined;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IWireService private readonly wire: IWireService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (scopeContext.agentId !== MAIN_AGENT_ID) return;
    this._register(
      injector.register(
        SESSION_START_INJECTION_VARIANT,
        async () => this.enqueue(() => this.reconcileSessionStartReminder()),
      ),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (sourceId === PLUGIN_SKILL_SOURCE_ID) {
          this.catalogRevision += 1;
        }
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

  private async renderLatestSessionStartReminder(): Promise<string | undefined> {
    while (this.renderedCatalogRevision !== this.catalogRevision) {
      const revision = this.catalogRevision;
      const reminder = await this.renderSessionStartReminder();
      if (revision !== this.catalogRevision) continue;
      this.renderedSessionStartReminder = reminder;
      this.renderedCatalogRevision = revision;
    }
    return this.renderedSessionStartReminder;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation);
    this.operationTail = next.then(
      () => undefined,
      (error: unknown) => {
        this.log.warn('failed to reconcile plugin sessionStart reminder', error);
      },
    );
    return next;
  }

  private async reconcileSessionStartReminder(): Promise<string | undefined> {
    const reminder = await this.renderLatestSessionStartReminder();
    const history = this.context.get();
    const baseline = this.wire.getModel(AgentPluginModel).current;
    const fingerprint = pluginSessionStartFingerprint(reminder);
    const active = reminder !== undefined;
    if (
      baseline.sessionStartFingerprint === fingerprint &&
      baseline.sessionStartActive === active &&
      isPluginSessionStartBaselineLive(history, reminder)
    ) {
      return undefined;
    }

    let content: string | undefined;
    if (reminder !== undefined) {
      content = hasPluginSessionStartReminder(history)
        ? `${reminder}\n\n${SESSION_START_SUPERSEDED_NOTE}`
        : reminder;
    } else if (baseline.sessionStartActive || hasPluginSessionStartReminder(history)) {
      content = SESSION_START_INACTIVE_REMINDER;
    }
    if (content !== undefined) this.markSessionStartBaseline(reminder);
    return content;
  }

  private markSessionStartBaseline(reminder: string | undefined): void {
    const fingerprint = pluginSessionStartFingerprint(reminder);
    const active = reminder !== undefined;
    const baseline = this.wire.getModel(AgentPluginModel).current;
    if (
      baseline.sessionStartFingerprint === fingerprint &&
      baseline.sessionStartActive === active
    ) {
      return;
    }
    this.wire.dispatch(setPluginSessionStartBaseline({ fingerprint, active }));
  }
}

function isPluginSessionStartBaselineLive(
  history: readonly {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly origin?: { readonly kind: string; readonly variant?: string };
  }[],
  reminder: string | undefined,
): boolean {
  const latest = history.findLast((message) => isPluginSessionStartReminder(message));
  if (latest === undefined) {
    return reminder === undefined;
  }
  const text = latest.content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
  return reminder === undefined
    ? text.includes(SESSION_START_INACTIVE_REMINDER)
    : text.includes(reminder);
}

function pluginSessionStartFingerprint(reminder: string | undefined): string {
  return createHash('sha256').update(reminder ?? '').digest('hex');
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

function hasPluginSessionStartReminder(
  history: readonly { readonly origin?: { readonly kind: string; readonly variant?: string } }[],
): boolean {
  return history.some((message) => isPluginSessionStartReminder(message));
}

function isPluginSessionStartReminder(message: {
  readonly origin?: { readonly kind: string; readonly variant?: string };
}): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === SESSION_START_INJECTION_VARIANT
  );
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
