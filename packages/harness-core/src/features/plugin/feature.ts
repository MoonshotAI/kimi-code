import {
  createFeature,
  MAIN_AGENT_ID,
  ProviderCatalogRef,
  useAgent,
  useAgentStore,
  useBeforeStep,
  useInject,
  useSession,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { useExpose, useFire } from '@moonshot-ai/agent-core/kernel/index';

import { useMcpServerSource } from '#/features/mcp/config/sources';
import {
  getBuiltinDefaultProfile,
  ProfileCatalogRef,
  useProfileFinder,
  type AgentProfileBasePrompt,
  type ProfileCatalogFace,
} from '#/features/profiles/index';
import { SkillCatalogRef } from '#/features/skill/feature';
import { useSkillSource } from '#/features/skill/sources/source';

import { createPluginSessionStartReminder } from './agent/session-start';
import { createPluginMcpSource } from './contribute/mcp';
import { createPluginProfileFinder } from './contribute/profiles';
import { createPluginSkillSource } from './contribute/skills';
import {
  PluginRef,
  type CreatePluginProps,
  type PluginEvent,
  type PluginFace,
} from './face';
import { createPluginService } from './state/service';

export function createPlugin(props: CreatePluginProps): FeatureSpec<PluginEvent> {
  return createFeature<PluginEvent>('plugin', {
    app() {
      const host = props.host;
      if (host === undefined) return;
      const fire = useFire();
      const profiles = useInject(ProfileCatalogRef);
      const profilesCatalog = (): ProfileCatalogFace | undefined => profiles.value;
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
          void profilesCatalog()
            ?.reload()
            .catch(() => undefined);
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
      const basePrompt: AgentProfileBasePrompt = (context) => {
        const catalog = profilesCatalog();
        if (catalog !== undefined) return catalog.getDefault().renderSystemPrompt(context);
        return getBuiltinDefaultProfile().renderSystemPrompt(context);
      };
      useProfileFinder(
        createPluginProfileFinder({
          fs: host.fs,
          agentRoots: () => service.pluginAgentRoots(),
          basePrompt,
          warn: props.onWarn,
        }),
      );
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
      const host = props.host;
      if (host === undefined) return;
      const agent = useAgent();
      if (agent.agentId !== MAIN_AGENT_ID) return;
      const face = useInject(PluginRef).value;
      if (face === undefined) return;
      const skillCatalog = useInject(SkillCatalogRef);
      useBeforeStep(
        createPluginSessionStartReminder({
          agent,
          store: useAgentStore(),
          sessionId: useSession().sessionId,
          face,
          catalog: () => skillCatalog.value,
          warn: props.onWarn,
        }),
      );
    },
  });
}
