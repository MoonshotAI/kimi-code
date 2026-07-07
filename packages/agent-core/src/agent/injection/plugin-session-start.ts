import type { EnabledPluginSessionStart } from '../../plugin/types';
import type { SkillDefinition } from '../../skill';
import { escapeXmlAttr } from '../../utils/xml-escape';
import { DynamicInjector } from './injector';

export interface RenderPluginSessionStartReminderInput {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly registry:
    | {
        getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
        renderSkillPrompt(skill: SkillDefinition, args: string): string;
      }
    | undefined;
  readonly log?: { warn(message: string, payload?: unknown): void };
}

/**
 * Renders the `<plugin_session_start>` reminder blocks for the currently enabled
 * plugin session starts. Returns `undefined` when there is nothing to render
 * (no session starts, no registry, or no resolvable skills).
 *
 * Shared by the turn-loop injector (which dedups against history) and the
 * explicit `/reload` flow (which force-appends a fresh reminder).
 */
export function renderPluginSessionStartReminder(
  input: RenderPluginSessionStartReminderInput,
): string | undefined {
  const { sessionStarts, registry, log } = input;
  if (sessionStarts.length === 0) return undefined;
  if (registry === undefined) return undefined;
  const blocks: string[] = [];
  for (const sessionStart of sessionStarts) {
    const skill = registry.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
    if (skill === undefined) {
      log?.warn('plugin sessionStart skill not found', {
        pluginId: sessionStart.pluginId,
        skillName: sessionStart.skillName,
      });
      continue;
    }
    blocks.push(renderSessionStartBlock(sessionStart, skill, registry.renderSkillPrompt(skill, '')));
  }
  if (blocks.length === 0) return undefined;
  return blocks.join('\n');
}

export class PluginSessionStartInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plugin_session_start';

  protected override async getInjection(): Promise<string | undefined> {
    if (this.injectedAt !== null) return undefined;
    const replayedAt = this.agent.context.history.findIndex(
      (message) =>
        message.origin?.kind === 'injection' &&
        message.origin.variant === this.injectionVariant,
    );
    if (replayedAt >= 0) {
      this.injectedAt = replayedAt;
      return undefined;
    }
    return renderPluginSessionStartReminder({
      sessionStarts: this.agent.pluginSessionStarts,
      registry: this.agent.skills?.registry,
      log: this.agent.log,
    });
  }
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
