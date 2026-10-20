import {
  createFeature,
  useAgent,
  useSession,
  useStepStarting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import { useCleanup, useExpose, useFire, useInject } from '@moonshot-ai/agent-core/kernel/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { useMcpServerSource } from '#/features/mcp/config/sources';
import { ProviderCatalogRef } from '#/features/provider-catalog/index';
import { SkillCatalogRef, useSkillSource } from '#/features/skill/index';
import { useFeatureStore } from '#/runtime/index';

import { createPluginSessionStartReminder, pluginSessionStartProjection } from './agent/session-start';
import { createPluginMcpSource } from './contribute/mcp';
import { createPluginSkillSource } from './contribute/skills';
import { PluginRef, type CreatePluginProps, type PluginEvent, type PluginFace } from './face';
import { PLUGIN_HOOK_SOURCE_ID } from './hooks';
import { createPluginService } from './state/service';

export function createPlugin(props: CreatePluginProps): Feature<void, PluginEvent> {
  return createFeature<PluginEvent>('plugin', {
    app() {
      const host = props.host;
      if (host === undefined) return;
      const fire = useFire();
      const providerCatalog = useInject(ProviderCatalogRef);
      const changeListeners = new Set<() => void>();
      const onDidChange = (listener: () => void): (() => void) => {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      };
      let refreshSkillIndex: () => Promise<void> = () => Promise.resolve();
      const service = createPluginService({
        homeDir: props.homeDir,
        fs: host.fs,
        warn: props.onWarn,
        providerInfo: (providerId) => providerCatalog.value?.providerInfo(providerId),
        onReload: async (summary, mutation) => {
          fire({ type: 'plugin.changed', summary });
          await refreshSkillIndex();
          for (const listener of changeListeners) listener();
          if (mutation !== undefined) {
            fire({ type: 'plugin.mutated', summary: { ...summary, mutation } });
          }
        },
      });
      const skillSource = createPluginSkillSource({
        fs: host.fs,
        roots: () => service.pluginSkillRoots(),
        warn: props.onWarn,
        onDidChange,
      });
      refreshSkillIndex = async () => {
        await skillSource.refresh(service.skillRootsNow()).catch(() => undefined);
      };
      useSkillSource(skillSource.source);
      useMcpServerSource(
        createPluginMcpSource({
          servers: () => service.enabledMcpServers(),
          onDidChange,
        }),
      );
      const releaseHookSource = props.useHookSource?.({
        id: PLUGIN_HOOK_SOURCE_ID,
        load: () => service.enabledHooks(),
        onDidChange,
      });
      if (releaseHookSource !== undefined) useCleanup(releaseHookSource);
      useExpose(PluginRef, {
        lastMutation: service.lastMutation,
        lastReload: service.lastReload,
        listPlugins: () => service.listPlugins(),
        installPlugin: (source) => service.installPlugin(source),
        setPluginEnabled: (id, enabled) => service.setPluginEnabled(id, enabled),
        setPluginMcpServerEnabled: (id, server, enabled) =>
          service.setPluginMcpServerEnabled(id, server, enabled),
        removePlugin: (id) => service.removePlugin(id),
        reloadPlugins: () => service.reloadPlugins(),
        getPluginInfo: (id) => service.getPluginInfo(id),
        listPluginCommands: () => service.listPluginCommands(),
        checkUpdates: () => service.checkUpdates(),
        pluginSkillRoots: () => service.pluginSkillRoots(),
        pluginAgentRoots: () => service.pluginAgentRoots(),
        enabledSessionStarts: () => service.enabledSessionStarts(),
        enabledSystemPrompts: () => service.enabledSystemPrompts(),
        enabledMcpServers: () => service.enabledMcpServers(),
        mcpServerEntries: () => service.mcpServerEntries(),
        enabledHooks: () => service.enabledHooks(),
        hasLoadedSnapshot: () => service.hasLoadedSnapshot(),
        getPluginSkill: (pluginId, name) => skillSource.getPluginSkill(pluginId, name),
      } satisfies PluginFace);
    },
    agent() {
      if (props.host === undefined) return;
      const agent = useAgent();
      if (agent.id !== MAIN_AGENT_ID) return;
      const face = useInject(PluginRef).value;
      if (face === undefined) return;
      const skillCatalog = useInject(SkillCatalogRef);
      const store = useFeatureStore('agent', 'plugin-session-start', pluginSessionStartProjection);
      useStepStarting(
        createPluginSessionStartReminder({
          agent,
          store,
          sessionId: useSession().id,
          face,
          catalog: () => skillCatalog.value,
          warn: props.onWarn,
        }),
        { id: 'plugin.session-start' },
      );
    },
  });
}
