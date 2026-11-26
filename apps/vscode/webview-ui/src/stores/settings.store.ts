import { create } from "zustand";
import { bridge } from "@/services";
import { toast } from "@/components/ui/sonner";
import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from "shared/errors";
import type {
  AccountProfileSnapshot,
  ExtensionConfig,
  WorkspaceTarget,
} from "shared/types";
import type { ModelConfig, ThinkingMode, SlashCommandInfo } from "shared/legacy-sdk";

let settingsSaveRevision = 0;
let accountProfileRevision = 0;
let authSessionEpoch = 0;
let switchWorkspaceFlight: Promise<SwitchWorkspaceOutcome> | null = null;
const MAX_RECENT_WORKSPACE_KEYS = 8;
const MANAGED_KIMI_CODE_PROVIDER = "managed:kimi-code";

function saveConfigWithRollback(
  config: Parameters<typeof bridge.saveConfig>[0],
  rollback: Partial<SettingsState>,
  set: (state: Partial<SettingsState>) => void,
): void {
  const revision = ++settingsSaveRevision;
  void bridge.saveConfig(config).catch((error: unknown) => {
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

function persistsAsDefaultEffort(model: ModelConfig, effort: string): boolean {
  const efforts = model.support_efforts ?? [];
  const declared = model.default_effort;
  const ceiling =
    declared !== undefined && efforts.includes(declared)
      ? efforts.indexOf(declared)
      : efforts.length - 2;
  return efforts.indexOf(effort) <= ceiling;
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

function pushRecentWorkspaceKey(existing: readonly string[], key: string | undefined): string[] {
  if (!key) return [...existing];
  return [key, ...existing.filter((item) => item !== key)].slice(0, MAX_RECENT_WORKSPACE_KEYS);
}

export interface SwitchWorkspaceOutcome {
  readonly ok: boolean;
  readonly revoked?: boolean;
  readonly warning?: string;
  readonly error?: string;
}

interface SettingsState {
  currentModel: string;
  thinkingEffort: string;
  extensionConfig: ExtensionConfig;
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
  accountProfile: AccountProfileSnapshot | null;
  accountProfileLoading: boolean;
  accountProfileError: string | null;
  recentWorkspaceKeys: string[];
  switchingWorkspaceKey: string | null;
  membershipRevokedOpen: boolean;
  membershipRevokedMessage: string;

  setCurrentModel: (model: string) => void;
  setModels: (
    models: ModelConfig[],
    nextDefaultModel?: string | null,
    nextDefaultThinking?: boolean,
    nextDefaultThinkingEffort?: string,
  ) => void;
  setThinkingEffort: (effort: string) => void;
  updateModel: (modelId: string) => void;
  toggleThinking: () => void;
  selectThinkingEffort: (effort: string) => void;
  setExtensionConfig: (config: ExtensionConfig) => void;
  setMCPModalOpen: (open: boolean) => void;
  setWorkDirModalOpen: (open: boolean) => void;
  setCurrentWorkDir: (workDir: string | null) => void;
  setWorkspaceRoot: (root: string | null) => void;
  initModels: (models: ModelConfig[], defaultModel: string | null, defaultThinking: boolean, defaultThinkingEffort?: string) => void;
  setWireSlashCommands: (commands: SlashCommandInfo[]) => void;
  setIsLoggedIn: (loggedIn: boolean) => void;
  setAccountProfile: (profile: AccountProfileSnapshot | null) => void;
  loadAccountProfile: () => Promise<void>;
  switchWorkspace: (target: WorkspaceTarget) => Promise<SwitchWorkspaceOutcome>;
  waitForWorkspaceSwitch: () => Promise<void>;
  triggerMembershipRevoked: (message?: string) => void;
  acknowledgeMembershipRevoked: () => void;
  getCurrentThinkingMode: () => ThinkingMode;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  currentModel: "",
  thinkingEffort: "off",
  extensionConfig: DEFAULT_EXTENSION_CONFIG,
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
  accountProfile: null,
  accountProfileLoading: false,
  accountProfileError: null,
  recentWorkspaceKeys: [],
  switchingWorkspaceKey: null,
  membershipRevokedOpen: false,
  membershipRevokedMessage: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,

  setCurrentModel: (currentModel) => set({ currentModel }),

  setModels: (models, nextDefaultModel, nextDefaultThinking, nextDefaultThinkingEffort) => {
    const { currentModel, defaultModel, defaultThinking, defaultThinkingEffort } = get();
    const resolvedDefault = nextDefaultModel !== undefined ? nextDefaultModel : defaultModel;
    const resolvedThinking =
      nextDefaultThinking !== undefined ? nextDefaultThinking : defaultThinking;
    const resolvedThinkingEffort =
      nextDefaultThinking !== undefined || nextDefaultThinkingEffort !== undefined
        ? nextDefaultThinkingEffort
        : defaultThinkingEffort;
    const defaultsPatch: Partial<SettingsState> = {
      ...(nextDefaultModel !== undefined ? { defaultModel: nextDefaultModel } : {}),
      ...(nextDefaultThinking !== undefined
        ? {
            defaultThinking: nextDefaultThinking,
            defaultThinkingEffort: nextDefaultThinkingEffort,
          }
        : nextDefaultThinkingEffort !== undefined
          ? { defaultThinkingEffort: nextDefaultThinkingEffort }
          : {}),
    };
    if (models.length === 0) {
      set({
        models,
        ...defaultsPatch,
        currentModel: "",
        thinkingEffort: "off",
      });
      return;
    }
    if (currentModel && getModelById(models, currentModel)) {
      set({
        models,
        ...defaultsPatch,
      });
      return;
    }
    const fallbackId =
      (resolvedDefault && getModelById(models, resolvedDefault) ? resolvedDefault : undefined) ??
      models[0]?.id ??
      "";
    const fallbackModel = getModelById(models, fallbackId);
    set({
      models,
      ...defaultsPatch,
      currentModel: fallbackId,
      thinkingEffort: fallbackModel
        ? defaultEffortForModel(fallbackModel, resolvedThinking, resolvedThinkingEffort)
        : "off",
    });
  },

  setThinkingEffort: (thinkingEffort) => set({ thinkingEffort }),

  updateModel: (modelId) => {
    const { models, defaultThinking, defaultThinkingEffort, currentModel, thinkingEffort: previousEffort } = get();
    const model = getModelById(models, modelId);
    if (!model) {
      return;
    }

    const thinkingEffort = defaultEffortForModel(model, defaultThinking, defaultThinkingEffort);
    const effortChanged = thinkingEffort !== previousEffort;
    set({
      currentModel: modelId,
      thinkingEffort,
      defaultThinkingEffort:
        effortChanged &&
        thinkingEffort !== "off" &&
        thinkingEffort !== "on" &&
        persistsAsDefaultEffort(model, thinkingEffort)
          ? thinkingEffort
          : defaultThinkingEffort,
    });
    saveConfigWithRollback(
      {
        model: modelId,
        thinking: thinkingEffort !== "off",
        effort: thinkingEffort,
        effortChanged,
      },
      { currentModel, thinkingEffort: previousEffort, defaultThinkingEffort },
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
    }

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
    let thinkingEffort = effort;
    if (thinkingEffort === "on" && getModelThinkingMode(model) === "effort") {
      thinkingEffort = defaultEffortForModel(model, true, defaultThinkingEffort);
    }
    const allowed = model.support_efforts ?? [];
    const alwaysOn = model.capabilities.includes("always_thinking");
    if (thinkingEffort !== "off" && thinkingEffort !== "on" && !allowed.includes(thinkingEffort)) return;
    if (alwaysOn && thinkingEffort === "off") return;
    if (thinkingEffort === previousEffort) return;
    set({
      thinkingEffort,
      defaultThinking: thinkingEffort !== "off",
      defaultThinkingEffort:
        thinkingEffort !== "off" &&
        thinkingEffort !== "on" &&
        persistsAsDefaultEffort(model, thinkingEffort)
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

  setIsLoggedIn: (isLoggedIn) => {
    if (isLoggedIn) {
      set({ isLoggedIn: true });
      return;
    }
    authSessionEpoch += 1;
    accountProfileRevision += 1;
    switchWorkspaceFlight = null;
    set({
      isLoggedIn: false,
      accountProfile: null,
      accountProfileLoading: false,
      accountProfileError: null,
      recentWorkspaceKeys: [],
      switchingWorkspaceKey: null,
    });
  },

  setAccountProfile: (profile) => {
    const currentKey = profile?.workspaces.find((ws) => ws.current)?.key;
    set((state) => ({
      accountProfile: profile,
      accountProfileError: null,
      recentWorkspaceKeys: pushRecentWorkspaceKey(state.recentWorkspaceKeys, currentKey),
    }));
  },

  loadAccountProfile: async () => {
    if (!get().isLoggedIn || typeof bridge.getAccountProfile !== "function") return;
    const revision = ++accountProfileRevision;
    const epoch = authSessionEpoch;
    set({ accountProfileLoading: true });
    try {
      const response = await bridge.getAccountProfile();
      if (revision !== accountProfileRevision || epoch !== authSessionEpoch || !get().isLoggedIn) {
        return;
      }
      if (response.kind === "error") {
        if (response.revoked) {
          get().triggerMembershipRevoked(response.message);
          return;
        }
        set({ accountProfileError: response.message });
        return;
      }
      const currentKey = response.profile.workspaces.find((ws) => ws.current)?.key;
      set((state) => ({
        accountProfile: response.profile,
        accountProfileError: null,
        recentWorkspaceKeys: pushRecentWorkspaceKey(state.recentWorkspaceKeys, currentKey),
      }));
    } catch (error) {
      if (revision !== accountProfileRevision || epoch !== authSessionEpoch || !get().isLoggedIn) {
        return;
      }
      set({
        accountProfileError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (revision === accountProfileRevision) {
        set({ accountProfileLoading: false });
      }
    }
  },

  switchWorkspace: async (target) => {
    const state = get();
    if (
      state.switchingWorkspaceKey !== null ||
      !state.isLoggedIn ||
      typeof bridge.switchWorkspace !== "function"
    ) {
      return { ok: false };
    }
    const epoch = authSessionEpoch;
    accountProfileRevision += 1;
    const targetKey = target.kind === "personal" ? "personal" : `business:${target.businessId}`;
    const previousCurrent = state.accountProfile?.workspaces.find((ws) => ws.current);
    const previousKey = previousCurrent?.key;
    const fromType: "personal" | "enterprise" =
      previousCurrent?.kind === "business" ? "enterprise" : "personal";
    set({ switchingWorkspaceKey: targetKey, accountProfileLoading: false });
    const flight = (async (): Promise<SwitchWorkspaceOutcome> => {
      try {
        const response = await bridge.switchWorkspace(target, fromType);
        if (epoch !== authSessionEpoch || !get().isLoggedIn) {
          return { ok: false, revoked: get().membershipRevokedOpen };
        }
        if (response.kind === "error") {
          if (response.revoked) {
            get().triggerMembershipRevoked(response.message);
            return { ok: false, revoked: true };
          }
          return { ok: false, error: response.message };
        }
        accountProfileRevision += 1;
        set((curr) => {
          const withPrev = pushRecentWorkspaceKey(curr.recentWorkspaceKeys, previousKey);
          const withTarget = pushRecentWorkspaceKey(withPrev, targetKey);
          const nextProfile =
            response.profile ??
            (curr.accountProfile
              ? {
                  ...curr.accountProfile,
                  workspaces: curr.accountProfile.workspaces.map((ws) => ({
                    ...ws,
                    current: ws.key === targetKey,
                  })),
                }
              : null);
          return {
            accountProfile: nextProfile,
            accountProfileLoading: false,
            accountProfileError: null,
            recentWorkspaceKeys: withTarget,
          };
        });
        if (response.profile === undefined) {
          void get().loadAccountProfile();
        }
        return {
          ok: true,
          ...(response.warning !== undefined ? { warning: response.warning } : {}),
        };
      } catch (error) {
        if (epoch !== authSessionEpoch || !get().isLoggedIn) {
          return { ok: false, revoked: get().membershipRevokedOpen };
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (get().switchingWorkspaceKey === targetKey) {
          set({ switchingWorkspaceKey: null });
        }
      }
    })().finally(() => {
      if (switchWorkspaceFlight === flight) {
        switchWorkspaceFlight = null;
      }
    });
    switchWorkspaceFlight = flight;
    return flight;
  },

  waitForWorkspaceSwitch: async () => {
    if (switchWorkspaceFlight !== null) {
      await switchWorkspaceFlight.catch(() => undefined);
    }
  },

  triggerMembershipRevoked: (message) => {
    authSessionEpoch += 1;
    accountProfileRevision += 1;
    switchWorkspaceFlight = null;
    set({
      isLoggedIn: false,
      accountProfile: null,
      accountProfileLoading: false,
      accountProfileError: null,
      recentWorkspaceKeys: [],
      switchingWorkspaceKey: null,
      membershipRevokedOpen: true,
      membershipRevokedMessage: message ?? BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });
  },

  acknowledgeMembershipRevoked: () => {
    set({ membershipRevokedOpen: false });
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
