import type { EnabledPluginSessionStart } from '../../plugin/types';
import type { SkillDefinition } from '../../skill';
import { DynamicInjector } from './injector';

export class PluginSessionStartInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plugin_session_start';

  protected override async getInjection(): Promise<string | undefined> {
    // 临时阅读注释：sessionStart 是一次性 skill 注入，不会执行插件脚本。
    if (this.injectedAt !== null) return undefined;
    // 临时阅读注释：resume/replay 时如果历史里已经有过 plugin sessionStart，就不重复注入。
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
      const skill = registry.getSkill(sessionStart.skillName);
      if (skill === undefined) {
        // 插件 enabled 了但 manifest 声明的 sessionStart skill 在 registry 里找不到。
        this.agent.log.warn('plugin sessionStart skill not found', {
          pluginId: sessionStart.pluginId,
          skillName: sessionStart.skillName,
        });
        continue;
      }
      // 临时阅读注释：必须走 renderSkillPrompt，这样插件的 kimi-plugin-instructions 也会一起被注入。
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
