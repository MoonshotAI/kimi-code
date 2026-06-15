import { create } from "zustand";
import { bridge } from "@/services";
import type { ExtensionConfig } from "shared/types";
import type { ConfigOptionUpdate, MCPServerConfig, ModelConfig, ThinkingMode, AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  executablePath: "",
  yoloMode: false,
  autosave: true,
  useCtrlEnterToSend: false,
  enableNewConversationShortcut: false,
  environmentVariables: {},
};

export function getModelThinkingMode(model: ModelConfig): ThinkingMode {
  if (model.capabilities.includes("always_thinking")) {
    return "always";
  }
  if (model.capabilities.includes("thinking")) {
    return "switch";
  }
  return "none";
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

type RawConfigOption = Record<string, unknown>;

function getOptionId(option: RawConfigOption): string {
  const rawId = option.configId ?? option.optionId ?? option.id ?? option.name;
  return typeof rawId === "string" ? rawId : "";
}

function getOptionValue(option: RawConfigOption): unknown {
  return option.value ?? option.currentValue ?? option.defaultValue;
}

function getStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function getOptionChoices(option: RawConfigOption): unknown[] {
  const choices = option.options ?? option.values ?? option.choices;
  return Array.isArray(choices) ? choices : [];
}

function modelFromChoice(choice: unknown, existingModels: ModelConfig[] = []): ModelConfig | null {
  if (typeof choice === "string") {
    const existingModel = getModelById(existingModels, choice);
    return { id: choice, name: existingModel?.name ?? choice, capabilities: existingModel?.capabilities ?? [] };
  }
  if (!choice || typeof choice !== "object") {
    return null;
  }

  const raw = choice as RawConfigOption;
  const id = getStringValue(raw.value ?? raw.id ?? raw.model ?? raw.name);
  if (!id) {
    return null;
  }

  const existingModel = getModelById(existingModels, id);
  const name = getStringValue(raw.label ?? raw.name ?? raw.title ?? raw.value ?? raw.id) ?? existingModel?.name ?? id;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((item): item is string => typeof item === "string")
    : (existingModel?.capabilities ?? []);

  return { id, name, capabilities };
}

function parseModelsFromOption(option: RawConfigOption, existingModels: ModelConfig[] = []): ModelConfig[] {
  const models = getOptionChoices(option)
    .map((choice) => modelFromChoice(choice, existingModels))
    .filter((model): model is ModelConfig => model !== null);
  if (models.length > 0) {
    return models;
  }

  const value = getStringValue(getOptionValue(option));
  if (!value) {
    return [];
  }
  const existingModel = getModelById(existingModels, value);
  return [{ id: value, name: existingModel?.name ?? value, capabilities: existingModel?.capabilities ?? [] }];
}

function isThinkingOn(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  if (value === "on" || value === "true" || value === "enabled") {
    return true;
  }
  if (value === "off" || value === "false" || value === "disabled") {
    return false;
  }
  return null;
}

interface SettingsState {
  currentModel: string;
  thinkingEnabled: boolean;
  /** Ephemeral, per-conversation ACP mode. */
  mode: AgentMode;
  /** Ephemeral, per-conversation YOLO state. Distinct from the persistent
   *  `extensionConfig.yoloMode` default; toggled by `/yolo` and the YoloPill,
   *  reset to the default on each new conversation, and passed via streamChat. */
  yoloMode: boolean;
  extensionConfig: ExtensionConfig;
  mcpServers: MCPServerConfig[];
  mcpModalOpen: boolean;
  models: ModelConfig[];
  defaultModel: string | null;
  defaultThinking: boolean;
  modelsLoaded: boolean;

  setCurrentModel: (model: string) => void;
  setThinkingEnabled: (enabled: boolean) => void;
  updateModel: (modelId: string) => void;
  toggleThinking: () => void;
  setExtensionConfig: (config: ExtensionConfig) => void;
  /** Set the ephemeral per-conversation ACP mode. */
  setMode: (mode: AgentMode) => void;
  /** Set the ephemeral per-conversation YOLO state. */
  setYoloMode: (enabled: boolean) => void;
  /** Reset ephemeral mode back to the persistent `kimi.yoloMode` default. */
  resetMode: () => void;
  /** Reset ephemeral YOLO back to the persistent `kimi.yoloMode` default. */
  resetYoloMode: () => void;
  setMCPServers: (servers: MCPServerConfig[]) => void;
  setMCPModalOpen: (open: boolean) => void;
  initModels: (models: ModelConfig[], defaultModel: string | null, defaultThinking: boolean) => void;
  applyConfigOptionUpdate: (update: ConfigOptionUpdate) => void;

  // Computed getters
  getCurrentThinkingMode: () => ThinkingMode;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  currentModel: "",
  thinkingEnabled: false,
  mode: "default",
  yoloMode: false,
  extensionConfig: DEFAULT_EXTENSION_CONFIG,
  mcpServers: [],
  mcpModalOpen: false,
  models: [],
  defaultModel: null,
  defaultThinking: false,
  modelsLoaded: false,

  setCurrentModel: (currentModel) => set({ currentModel }),

  setThinkingEnabled: (thinkingEnabled) => set({ thinkingEnabled }),

  updateModel: (modelId) => {
    const { models, defaultThinking } = get();
    const model = getModelById(models, modelId);
    if (!model) {
      return;
    }

    const thinkingMode = getModelThinkingMode(model);
    let thinkingEnabled: boolean;

    if (thinkingMode === "always") {
      thinkingEnabled = true;
    } else if (thinkingMode === "none") {
      thinkingEnabled = false;
    } else {
      // switch mode - use default preference
      thinkingEnabled = defaultThinking;
    }

    set({ currentModel: modelId, thinkingEnabled });
    bridge.saveConfig({ model: modelId, thinking: thinkingEnabled });
  },

  toggleThinking: () => {
    const { models, currentModel, thinkingEnabled } = get();
    const model = getModelById(models, currentModel);
    if (!model) {
      return;
    }

    const thinkingMode = getModelThinkingMode(model);
    if (thinkingMode !== "switch") {
      return;
    } // Can only toggle in switch mode

    const newThinking = !thinkingEnabled;
    set({ thinkingEnabled: newThinking, defaultThinking: newThinking });
    bridge.saveConfig({ model: currentModel, thinking: newThinking });
  },

  setExtensionConfig: (extensionConfig) => set({ extensionConfig }),

  setMode: (mode) => set({ mode, yoloMode: mode === "yolo" }),

  setYoloMode: (enabled) => get().setMode(enabled ? "yolo" : "default"),

  resetMode: () => set((state) => {
    const mode: AgentMode = state.extensionConfig.yoloMode ? "yolo" : "default";
    return { mode, yoloMode: mode === "yolo" };
  }),

  resetYoloMode: () => get().resetMode(),

  setMCPServers: (mcpServers) => set({ mcpServers }),

  setMCPModalOpen: (mcpModalOpen) => set({ mcpModalOpen }),

  initModels: (models, defaultModel, defaultThinking) => {
    const initialModel = defaultModel || (models.length > 0 ? models[0].id : "");
    const model = getModelById(models, initialModel);

    let thinkingEnabled = false;
    if (model) {
      const thinkingMode = getModelThinkingMode(model);
      if (thinkingMode === "always") {
        thinkingEnabled = true;
      } else if (thinkingMode === "switch") {
        thinkingEnabled = defaultThinking;
      }
    }

    set({
      models,
      defaultModel,
      defaultThinking,
      modelsLoaded: true,
      currentModel: initialModel,
      thinkingEnabled,
    });
  },

  applyConfigOptionUpdate: (update) => {
    const next: Partial<SettingsState> = {};

    for (const option of update.configOptions as RawConfigOption[]) {
      const id = getOptionId(option);
      const value = getOptionValue(option);

      if (id === "model") {
        const models = parseModelsFromOption(option, get().models);
        const currentModel = getStringValue(value) ?? models[0]?.id;

        if (models.length > 0) {
          next.models = models;
          next.modelsLoaded = true;
        }
        if (currentModel) {
          next.currentModel = currentModel;
          next.defaultModel = currentModel;
        }
      } else if (id === "thinking") {
        const thinkingEnabled = isThinkingOn(value);

        if (thinkingEnabled !== null) {
          next.thinkingEnabled = thinkingEnabled;
          next.defaultThinking = thinkingEnabled;
        }
      } else if (id === "mode") {
        const mode = getStringValue(value);

        if (mode === "default" || mode === "plan" || mode === "auto" || mode === "yolo") {
          // The server reports the live mode; reflect it in the ephemeral
          // per-conversation state so the indicator stays in sync.
          next.mode = mode;
          next.yoloMode = mode === "yolo";
        }
      }
    }

    set(next);
  },

  getCurrentThinkingMode: () => {
    const { models, currentModel } = get();
    const model = getModelById(models, currentModel);
    if (!model) {
      return "none";
    }
    return getModelThinkingMode(model);
  },
}));
