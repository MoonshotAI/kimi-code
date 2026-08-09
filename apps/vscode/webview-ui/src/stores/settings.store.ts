import { create } from "zustand";
import { bridge } from "@/services";
import { toast } from "@/components/ui/sonner";
import type { ExtensionConfig } from "shared/types";
import type { MCPServerConfig, ModelConfig, ThinkingMode, SlashCommandInfo } from "shared/legacy-sdk";

let settingsSaveRevision = 0;
const MANAGED_KIMI_CODE_PROVIDER = "managed:kimi-code";

function saveConfigWithRollback(
  config: Parameters<typeof bridge.saveConfig>[0],
  rollback: Partial<SettingsState>,
  set: (state: Partial<SettingsState>) => void,
): void {
  const revision = ++settingsSaveRevision;
  void bridge.saveConfig(config).catch((error: unknown) => {
    // A later selection supersedes this request; rolling an older request back
    // would overwrite the user's latest choice.
    if (revision !== settingsSaveRevision) return;
    set(rollback);
    toast.error(`Failed to save model settings: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  yoloMode: false,
  autosave: true,
  useCtrlEnterToSend: false,
  enableNewConversationShortcut: false,
  showThinkingContent: true,
  showThinkingExpanded: true,
  version: "",
};

/** Metadata-driven only; mirrors the TUI's thinkingAvailability rules. */
export function getModelThinkingMode(model: ModelConfig): ThinkingMode {
  if ((model.support_efforts?.length ?? 0) > 0) {
    return "effort";
  }
  if (model.capabilities.includes("always_thinking")) {
    return "always";
  }
  if (model.capabilities.includes("thinking") || model.adaptive_thinking === true) {
    return "switch";
  }
  return "none";
}

export function providerDisplayName(provider: string): string {
  if (provider === MANAGED_KIMI_CODE_PROVIDER) return "Kimi Code";
  if (provider.startsWith("managed:")) return provider.slice("managed:".length);
  return provider;
}

export interface ModelProviderGroup {
  provider: string;
  label: string;
  models: ModelConfig[];
}

export function groupModelsByProvider(models: ModelConfig[]): ModelProviderGroup[] {
  const grouped = new Map<string, ModelConfig[]>();
  for (const model of models) {
    const group = grouped.get(model.provider);
    if (group === undefined) {
      grouped.set(model.provider, [model]);
    } else {
      group.push(model);
    }
  }
  return [...grouped.entries()]
    .map(([provider, providerModels]) => ({
      provider,
      label: providerDisplayName(provider),
      models: providerModels.toSorted((left, right) => left.name.localeCompare(right.name)),
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

export function requiresManagedProviderLogin(
  models: ModelConfig[],
  defaultModel: string | null,
  loggedIn: boolean,
): boolean {
  if (loggedIn) return false;
  const activeModel = getModelById(models, defaultModel ?? "") ?? models[0];
  return activeModel?.provider === MANAGED_KIMI_CODE_PROVIDER;
}

function defaultEffortForModel(model: ModelConfig, defaultThinking: boolean, configuredEffort?: string): string {
  const mode = getModelThinkingMode(model);
  if (mode === "none") return "off";
  const efforts = model.support_efforts ?? [];
  if (efforts.length > 0) {
    const alwaysOn = model.capabilities.includes("always_thinking");
    if (!defaultThinking && !alwaysOn) return "off";
    if (configuredEffort && efforts.includes(configuredEffort)) return configuredEffort;
    if (model.default_effort && efforts.includes(model.default_effort)) return model.default_effort;
    return efforts[Math.floor(efforts.length / 2)] ?? "off";
  }
  if (mode === "always") return "on";
  return defaultThinking ? "on" : "off";
}

export function isImageModel(model: ModelConfig): boolean {
  return model.capabilities.includes("image_in");
}

export function isVideoModel(model: ModelConfig): boolean {
  return model.capabilities.includes("video_in");
}

export function getModelById(models: ModelConfig[], id: string): ModelConfig | undefined {
  return models.find((m) => m.id === id);
}

export interface MediaRequirements {
  image: boolean;
  video: boolean;
}

export function getModelsForMedia(models: ModelConfig[], mediaReq: MediaRequirements): ModelConfig[] {
  return models.filter((m) => {
    if (mediaReq.image && !isImageModel(m)) {
      return false;
    }
    if (mediaReq.video && !isVideoModel(m)) {
      return false;
    }
    return true;
  });
}

export function getMediaFallbackModel(
  compatibleModels: ModelConfig[],
  currentModel?: ModelConfig,
): ModelConfig | undefined {
  return compatibleModels.find((model) => model.provider === currentModel?.provider)
    ?? compatibleModels[0];
}

interface SettingsState {
  currentModel: string;
  thinkingEffort: string;
  extensionConfig: ExtensionConfig;
  mcpServers: MCPServerConfig[];
  mcpModalOpen: boolean;
  workDirModalOpen: boolean;
  currentWorkDir: string | null;
  workspaceRoot: string | null;
  models: ModelConfig[];
  defaultModel: string | null;
  defaultThinking: boolean;
  defaultThinkingEffort?: string;
  modelsLoaded: boolean;
  wireSlashCommands: SlashCommandInfo[];
  slashCommands: SlashCommandInfo[];
  isLoggedIn: boolean;

  setCurrentModel: (model: string) => void;
  setThinkingEffort: (effort: string) => void;
  updateModel: (modelId: string) => void;
  toggleThinking: () => void;
  selectThinkingEffort: (effort: string) => void;
  setExtensionConfig: (config: ExtensionConfig) => void;
  setMCPServers: (servers: MCPServerConfig[]) => void;
  setMCPModalOpen: (open: boolean) => void;
  setWorkDirModalOpen: (open: boolean) => void;
  setCurrentWorkDir: (workDir: string | null) => void;
  setWorkspaceRoot: (root: string | null) => void;
  initModels: (models: ModelConfig[], defaultModel: string | null, defaultThinking: boolean, defaultThinkingEffort?: string) => void;
  setWireSlashCommands: (commands: SlashCommandInfo[]) => void;
  setIsLoggedIn: (loggedIn: boolean) => void;
  getCurrentThinkingMode: () => ThinkingMode;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  currentModel: "",
  thinkingEffort: "off",
  extensionConfig: DEFAULT_EXTENSION_CONFIG,
  mcpServers: [],
  mcpModalOpen: false,
  workDirModalOpen: false,
  currentWorkDir: null,
  workspaceRoot: null,
  models: [],
  defaultModel: null,
  defaultThinking: false,
  modelsLoaded: false,
  wireSlashCommands: [],
  slashCommands: [],
  isLoggedIn: false,

  setCurrentModel: (currentModel) => set({ currentModel }),

  setThinkingEffort: (thinkingEffort) => set({ thinkingEffort }),

  updateModel: (modelId) => {
    const { models, defaultThinking, defaultThinkingEffort, currentModel, thinkingEffort: previousEffort } = get();
    const model = getModelById(models, modelId);
    if (!model) {
      return;
    }

    const thinkingEffort = defaultEffortForModel(model, defaultThinking, defaultThinkingEffort);
    set({ currentModel: modelId, thinkingEffort });
    saveConfigWithRollback(
      {
        model: modelId,
        thinking: thinkingEffort !== "off",
        effort: thinkingEffort,
        effortChanged: thinkingEffort !== previousEffort,
      },
      { currentModel, thinkingEffort: previousEffort },
      set,
    );
  },

  toggleThinking: () => {
    const { models, currentModel, thinkingEffort, defaultThinking } = get();
    const model = getModelById(models, currentModel);
    if (!model) {
      return;
    }

    const thinkingMode = getModelThinkingMode(model);
    if (thinkingMode !== "switch") {
      return;
    } // Can only toggle in switch mode

    const newEffort = thinkingEffort === "off" ? "on" : "off";
    set({ thinkingEffort: newEffort, defaultThinking: newEffort !== "off" });
    saveConfigWithRollback(
      { model: currentModel, thinking: newEffort !== "off", effort: newEffort },
      { thinkingEffort, defaultThinking },
      set,
    );
  },

  selectThinkingEffort: (effort) => {
    const { models, currentModel, thinkingEffort: previousEffort, defaultThinking, defaultThinkingEffort } = get();
    const model = getModelById(models, currentModel);
    if (!model) return;
    // Match the TUI's commitEffort rule: a boolean "on" never reaches the
    // engine for effort-capable models; resolve it to the model's default
    // effort first. "on" remains valid only for genuine boolean models.
    let thinkingEffort = effort;
    if (thinkingEffort === "on" && getModelThinkingMode(model) === "effort") {
      thinkingEffort = defaultEffortForModel(model, true, defaultThinkingEffort);
    }
    const allowed = model.support_efforts ?? [];
    const alwaysOn = model.capabilities.includes("always_thinking");
    if (thinkingEffort !== "off" && thinkingEffort !== "on" && !allowed.includes(thinkingEffort)) return;
    if (alwaysOn && thinkingEffort === "off") return;
    // Re-confirming the effort already shown is not an explicit choice —
    // skip the state update and the config write entirely.
    if (thinkingEffort === previousEffort) return;
    set({
      thinkingEffort,
      defaultThinking: thinkingEffort !== "off",
      // The model's top declared tier is session-only (only the boolean
      // toggle is persisted), so it must not become the configured-effort
      // seed for future sessions.
      defaultThinkingEffort:
        thinkingEffort !== "off" && thinkingEffort !== "on" && thinkingEffort !== allowed.at(-1)
          ? thinkingEffort
          : defaultThinkingEffort,
    });
    saveConfigWithRollback(
      { model: currentModel, thinking: thinkingEffort !== "off", effort: thinkingEffort },
      { thinkingEffort: previousEffort, defaultThinking, defaultThinkingEffort },
      set,
    );
  },

  setExtensionConfig: (extensionConfig) => set({ extensionConfig }),

  setMCPServers: (mcpServers) => set({ mcpServers }),

  setMCPModalOpen: (mcpModalOpen) => set({ mcpModalOpen }),

  setWorkDirModalOpen: (workDirModalOpen) => set({ workDirModalOpen }),

  setCurrentWorkDir: (currentWorkDir) => set({ currentWorkDir }),

  setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),

  initModels: (models, defaultModel, defaultThinking, defaultThinkingEffort) => {
    settingsSaveRevision += 1;
    const initialModel = defaultModel || models[0]?.id || "";
    const model = getModelById(models, initialModel);

    const thinkingEffort = model ? defaultEffortForModel(model, defaultThinking, defaultThinkingEffort) : "off";

    set({
      models,
      defaultModel,
      defaultThinking,
      defaultThinkingEffort,
      modelsLoaded: true,
      currentModel: initialModel,
      thinkingEffort,
    });
  },

  setWireSlashCommands: (commands) => {
    set({
      wireSlashCommands: commands,
      slashCommands: commands,
    });
  },

  setIsLoggedIn: (isLoggedIn) => set({ isLoggedIn }),

  getCurrentThinkingMode: () => {
    const { models, currentModel } = get();
    const model = getModelById(models, currentModel);
    if (!model) {
      return "none";
    }
    return getModelThinkingMode(model);
  },
}));
