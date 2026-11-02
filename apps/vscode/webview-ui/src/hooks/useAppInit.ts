import { useState, useEffect, useCallback, useRef } from "react";
import { bridge, Events } from "@/services";
import { requiresManagedProviderLogin, resolveSendModel, useSettingsStore } from "@/stores";
import type { KimiConfig as WebviewKimiConfig, ModelCatalogChangedEvent } from "shared/legacy-sdk";
import type { ExtensionConfig } from "shared/types";

export type AppStatus = "loading" | "no-workspace" | "runtime-error" | "not-logged-in" | "no-models" | "ready";
export type ModelCatalogStatus = "not-logged-in" | "no-models" | "ready";

export type ConfigErrorStatus = "loading" | "no-workspace" | "runtime-error" | "no-models";

export type AppViewResolution =
  | { readonly view: "login" }
  | {
      readonly view: "status";
      readonly status: ConfigErrorStatus;
      /** True when the status screen must offer a path to the sign-in screen. */
      readonly canGoToLogin: boolean;
    }
  | { readonly view: "main" };

/**
 * Pure view router for App. The `no-models` status (a managed OAuth token
 * exists but config.toml has no models — e.g. a first login whose model
 * provisioning failed after the device flow already persisted the token)
 * must always keep a path back to the sign-in screen: Reload alone cannot
 * change the on-disk state, so without it the user is stranded and the
 * login UI becomes unreachable.
 */
export function resolveAppView(input: {
  readonly status: AppStatus;
  readonly modelsCount: number;
  readonly skippedLogin: boolean;
  readonly showLogin: boolean;
}): AppViewResolution {
  const { status, modelsCount, skippedLogin, showLogin } = input;
  if (showLogin || (status === "not-logged-in" && !skippedLogin)) {
    return { view: "login" };
  }
  if (skippedLogin && modelsCount === 0) {
    return { view: "status", status: "no-models", canGoToLogin: true };
  }
  if (status !== "ready" && status !== "not-logged-in") {
    return { view: "status", status, canGoToLogin: status === "no-models" };
  }
  return { view: "main" };
}

export function resolveModelCatalogStatus(
  config: WebviewKimiConfig,
  loggedIn: boolean,
): ModelCatalogStatus {
  if (config.models.length === 0) return loggedIn ? "no-models" : "not-logged-in";
  return requiresManagedProviderLogin(config.models, config.defaultModel, loggedIn)
    ? "not-logged-in"
    : "ready";
}

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
  const modelCatalogRevision = useRef(0);
  const {
    initModels,
    syncModels,
    setExtensionConfig,
    setWireSlashCommands,
    setIsLoggedIn,
    setWorkspaceRoot,
  } = useSettingsStore();

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
    return bridge.on<ModelCatalogChangedEvent>(Events.ModelCatalogChanged, ({ config, retiredDefault }) => {
      modelCatalogRevision.current += 1;
      syncModels(
        config.models,
        config.defaultModel,
        config.defaultThinking,
        config.defaultThinkingEffort,
        retiredDefault,
      );
      const synced = useSettingsStore.getState();
      const syncedConfig = {
        ...config,
        models: synced.models,
        defaultModel: resolveSendModel(synced.models, synced.currentModel, synced.defaultModel)?.id ?? null,
      };
      setState((current) => {
        const modelsCount = syncedConfig.models.length;
        if (current.status !== "ready" && current.status !== "no-models" && current.status !== "not-logged-in") {
          return { ...current, modelsCount };
        }
        return {
          status: resolveModelCatalogStatus(syncedConfig, synced.isLoggedIn),
          errorMessage: null,
          modelsCount,
        };
      });
    });
  }, [syncModels]);

  useEffect(() => {
    let cancelled = false;
    const catalogRevisionAtStart = modelCatalogRevision.current;

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

        const [extensionConfig, slashCommands] = await Promise.all([
          bridge.getExtensionConfig(),
          bridge.getSlashCommands(),
        ]);
        if (cancelled) {
          return;
        }

        setExtensionConfig(extensionConfig);
        setWireSlashCommands(slashCommands);

        const [loginStatus, kimiConfig] = await Promise.all([bridge.checkLoginStatus(), bridge.getModels()]);
        if (cancelled) {
          return;
        }

        console.log("[AppInit] Login status:", loginStatus, "kimiConfig:", kimiConfig);

        setIsLoggedIn(loginStatus.loggedIn);
        if (modelCatalogRevision.current !== catalogRevisionAtStart) {
          const synced = useSettingsStore.getState();
          const syncedConfig = {
            ...kimiConfig,
            models: synced.models,
            defaultModel: resolveSendModel(synced.models, synced.currentModel, synced.defaultModel)?.id ?? null,
          };
          const modelsCount = syncedConfig.models.length;
          setState({
            status: resolveModelCatalogStatus(syncedConfig, synced.isLoggedIn),
            errorMessage: null,
            modelsCount,
          });
          return;
        }

        initModels(kimiConfig.models, kimiConfig.defaultModel, kimiConfig.defaultThinking, kimiConfig.defaultThinkingEffort);

        const modelsCount = kimiConfig.models.length;
        setState({
          status: resolveModelCatalogStatus(kimiConfig, loginStatus.loggedIn),
          errorMessage: null,
          modelsCount,
        });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "runtime-error",
            errorMessage: error instanceof Error ? error.message : "Failed to initialize",
            modelsCount: 0,
          });
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [initKey, initModels, setExtensionConfig, setWireSlashCommands, setIsLoggedIn]);

  return { ...state, refresh };
}
