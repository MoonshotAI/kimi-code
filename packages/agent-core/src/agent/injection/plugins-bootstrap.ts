import { DynamicInjector } from './injector';

export class PluginsBootstrapInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plugins_bootstrap';

  protected override async getInjection(): Promise<string | undefined> {
    if (this.injectedAt !== null) return undefined;
    const bootstraps = this.agent.pluginBootstraps ?? [];
    if (bootstraps.length === 0) return undefined;
    const blocks: string[] = [];
    for (const bootstrap of bootstraps) {
      const skill = this.agent.skills?.registry.getSkill(bootstrap.skillName);
      if (skill === undefined) continue;
      blocks.push(
        `<plugin_bootstrap plugin="${escapeAttr(bootstrap.pluginId)}" ` +
          `skill="${escapeAttr(bootstrap.skillName)}">\n${skill.content}\n</plugin_bootstrap>`,
      );
    }
    if (blocks.length === 0) return undefined;
    return blocks.join('\n');
  }
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}
