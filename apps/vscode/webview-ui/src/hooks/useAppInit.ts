import { useState, useEffect, useCallback } from "react";
import { bridge, Events } from "@/services";
import { requiresManagedProviderLogin, useSettingsStore } from "@/stores";
import type { ExtensionConfig } from "shared/types";

export type AppStatus = "loading" | "no-workspace" | "runtime-error" | "not-logged-in" | "no-models" | "ready";

export interface AppInitState {
  status: AppStatus;
  errorMessage: string | null;
  modelsCount: number;
  refresh: () => void;
}

export function useAppInit(): AppInitState {
  const [state, setState] = useState<Omit<AppInitState, "refresh">>({
    status: "loading",
    errorMessage: null,
    modelsCount: 0,
  });
  const [initKey, setInitKey] = useState(0);
  const { initModels, setExtensionConfig, setMCPServers, setWireSlashCommands, setIsLoggedIn, setWorkspaceRoot } = useSettingsStore();

  const refresh = useCallback(() => {
    setState({ status: "loading", errorMessage: null, modelsCount: 0 });
    setInitKey((k) => k + 1);
  }, []);

  useEffect(() => {
    return bridge.on<{ config: ExtensionConfig; changedKeys: string[] }>(Events.ExtensionConfigChanged, ({ config }) => {
      setExtensionConfig(config);
    });
  }, [setExtensionConfig, refresh]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const workspace = await bridge.checkWorkspace();
        if (cancelled) {
          return;
        }

        if (!workspace.hasWorkspace) {
          setState({ status: "no-workspace", errorMessage: null, modelsCount: 0 });
          return;
        }

        setWorkspaceRoot(workspace.workspaceRoot ?? workspace.path ?? null);

        const [extensionConfig, mcpServers, slashCommands] = await Promise.all([
          bridge.getExtensionConfig(),
          bridge.getMCPServers(),
          bridge.getSlashCommands(),
        ]);
        if (cancelled) {
          return;
        }

        setExtensionConfig(extensionConfig);
        setMCPServers(mcpServers);
        setWireSlashCommands(slashCommands);

        const [loginStatus, kimiConfig] = await Promise.all([bridge.checkLoginStatus(), bridge.getModels()]);
        if (cancelled) {
          return;
        }

        console.log("[AppInit] Login status:", loginStatus, "kimiConfig:", kimiConfig);

        setIsLoggedIn(loginStatus.loggedIn);
        initModels(kimiConfig.models, kimiConfig.defaultModel, kimiConfig.defaultThinking, kimiConfig.defaultThinkingEffort);

        const modelsCount = kimiConfig.models?.length ?? 0;

        if (modelsCount === 0 && !loginStatus.loggedIn) {
          setState({ status: "not-logged-in", errorMessage: null, modelsCount });
          return;
        }

        if (modelsCount === 0) {
          setState({ status: "no-models", errorMessage: null, modelsCount: 0 });
          return;
        }

        if (requiresManagedProviderLogin(kimiConfig.models, kimiConfig.defaultModel, loginStatus.loggedIn)) {
          setState({ status: "not-logged-in", errorMessage: null, modelsCount });
          return;
        }

        setState({ status: "ready", errorMessage: null, modelsCount });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "runtime-error",
            errorMessage: err instanceof Error ? err.message : "Failed to initialize",
            modelsCount: 0,
          });
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [initKey, initModels, setExtensionConfig, setMCPServers, setWireSlashCommands, setIsLoggedIn]);

  return { ...state, refresh };
}
