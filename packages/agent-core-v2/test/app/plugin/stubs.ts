/**
 * `plugin` domain test stubs — shared plugin boundary fixtures.
 */

import { Event } from '#/_base/event';
import type { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart, ReloadSummary } from '#/app/plugin/types';

interface StubPluginServiceOptions {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
}

export function stubPluginService(options: StubPluginServiceOptions): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: Event.None as IPluginService['onDidReload'],
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async (): Promise<ReloadSummary> => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by this stub');
    },
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginAgentRoots: async () => [],
    enabledSessionStarts: async () => options.sessionStarts,
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
  };
}
