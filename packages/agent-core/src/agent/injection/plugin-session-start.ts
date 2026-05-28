import type { EnabledPluginSessionStart } from '../../plugin/types';
import type { SkillDefinition } from '../../skill';
import { DynamicInjector } from './injector';

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
    const sessionStarts = this.agent.pluginSessionStarts ?? [];
    if (sessionStarts.length === 0) return undefined;
    const registry = this.agent.skills?.registry;
    if (registry === undefined) return undefined;
    const blocks: string[] = [];
    for (const sessionStart of sessionStarts) {
      const skill = registry.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
      if (skill === undefined) {
        this.agent.log.warn('plugin sessionStart skill not found', {
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
}

function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

function escapeAttr(value: string): string {
  return value.replaceAll('"', '&quot;');
}
