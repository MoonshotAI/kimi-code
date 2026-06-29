import { useState, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { bridge, Events } from "@/services";
import { useSettingsStore } from "@/stores";
import type { ExtensionConfig } from "shared/types";

export type InitStatus = "loading" | "error" | "ready";
export type ErrorType = "no-workspace" | "cli-error" | "no-models" | null;

export interface AppInitState {
  status: InitStatus;
  errorType: ErrorType;
  errorMessage: string | null;
}

interface ConfigChangedPayload {
  config: ExtensionConfig;
  changedKeys: string[];
}

export function useAppInit(): AppInitState {
  const [state, setState] = useState<AppInitState>({
    status: "ready",
    errorType: null,
    errorMessage: null,
  });

  const { initModels, setExtensionConfig, setMCPServers, models, modelsLoaded } = useSettingsStore(
    useShallow((settings) => ({
      initModels: settings.initModels,
      setExtensionConfig: settings.setExtensionConfig,
      setMCPServers: settings.setMCPServers,
      models: settings.models,
      modelsLoaded: settings.modelsLoaded,
    })),
  );

  const checkCLIAndLoadModels = useCallback(async (): Promise<boolean> => {
    try {
      let installed = await bridge.checkCLI();
      console.log("CLI installed:", installed.ok);
      if (!installed.ok) {
        console.log("Installing CLI...");
        setState({ status: "loading", errorType: null, errorMessage: null });

        await bridge.installCLI();
        installed = await bridge.checkCLI();

        if (!installed.ok) {
          return false;
        }
      }

      const modelsData = await bridge.getModels();
      initModels(modelsData.models, modelsData.defaultModel, modelsData.defaultThinking);
      return true;
    } catch {
      return false;
    }
  }, [initModels]);

  // Initial load
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Check workspace
        const workspace = await bridge.checkWorkspace();

        if (!workspace.hasWorkspace) {
          setState({ status: "error", errorType: "no-workspace", errorMessage: null });
          return;
        }

        // Load extension config
        const extensionConfig = await bridge.getExtensionConfig();

        setExtensionConfig(extensionConfig);
        // Seed the ephemeral per-conversation YOLO from the persistent default
        // (only on initial load — not on later ExtensionConfigChanged broadcasts,
        // which would clobber an active `/yolo` toggle).
        useSettingsStore.getState().setYoloMode(extensionConfig.yoloMode);

        // Check CLI and load models
        const ok = await checkCLIAndLoadModels();
        if (cancelled) {
          return;
        }

        if (!ok) {
          setState({ status: "error", errorType: "cli-error", errorMessage: "Kimi CLI is not properly configured" });
          return;
        }

        // Load MCP servers
        bridge.getMCPServers().then(setMCPServers, (err) => {
          console.warn("Failed to load MCP servers:", err);
        });

        setState({ status: "ready", errorType: null, errorMessage: null });
      } catch (err) {
        setState({
          status: "error",
          errorType: "cli-error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [setExtensionConfig, setMCPServers, checkCLIAndLoadModels]);

  // Listen for config changes
  useEffect(() => {
    return bridge.on<ConfigChangedPayload>(Events.ExtensionConfigChanged, async (payload) => {
      setExtensionConfig(payload.config);

      if (!payload.changedKeys.includes("executablePath")) {
        return;
      }

      // Re-check CLI when executable path changes
      const ok = await checkCLIAndLoadModels();
      if (ok) {
        setState({ status: "ready", errorType: null, errorMessage: null });
      } else {
        setState({ status: "error", errorType: "cli-error", errorMessage: "Kimi CLI is not properly configured" });
      }
    });
  }, [setExtensionConfig, checkCLIAndLoadModels]);

  // Check for no models after loading
  if (state.status === "ready" && modelsLoaded && models.length === 0) {
    return { status: "error", errorType: "no-models", errorMessage: null };
  }

  return state;
}
