import { Event, type Emitter } from '#/_base/event';
import type { IPluginService } from '#/app/plugin/plugin';
import type {
  EnabledPluginSessionStart,
  PluginMutationSummary,
  PluginReloadEvent,
  ReloadSummary,
} from '#/app/plugin/types';

interface StubPluginServiceOptions {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly reloadEmitter?: Emitter<PluginReloadEvent>;
  readonly mutateEmitter?: Emitter<PluginMutationSummary>;
}

export function stubPluginService(options: StubPluginServiceOptions): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: options.reloadEmitter?.event ?? (Event.None as IPluginService['onDidReload']),
    onDidMutate: options.mutateEmitter?.event ?? (Event.None as IPluginService['onDidMutate']),
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
    mcpServerEntries: async () => [],
    enabledHooks: async () => [],
    hasLoadedSnapshot: () => true,
  };
}
