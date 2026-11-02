import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appInitBridge = vi.hoisted(() => ({
  on: vi.fn(),
  checkWorkspace: vi.fn(),
  getExtensionConfig: vi.fn(),
  getSlashCommands: vi.fn(),
  checkLoginStatus: vi.fn(),
  getModels: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: appInitBridge,
  Events: {
    ExtensionConfigChanged: "extensionConfigChanged",
    ModelCatalogChanged: "modelCatalogChanged",
  },
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { useAppInit } from "../../webview-ui/src/hooks/useAppInit";
import { useSettingsStore } from "../../webview-ui/src/stores/settings.store";

const MODEL_CATALOG_CHANGED = "modelCatalogChanged";
const PLAIN_MODEL = {
  id: "plain",
  name: "Plain",
  provider: "managed:kimi-code",
  capabilities: [],
};
const NEW_MODEL = {
  id: "new",
  name: "New",
  provider: "managed:kimi-code",
  capabilities: [],
};
const INITIAL_CONFIG = {
  models: [PLAIN_MODEL],
  defaultModel: "plain",
  defaultThinking: false,
};

type EventListener = (data: unknown) => void;
const listeners = new Map<string, Set<EventListener>>();

async function emitModelCatalogChanged(): Promise<void> {
  await act(async () => {
    for (const listener of [...(listeners.get(MODEL_CATALOG_CHANGED) ?? [])]) {
      listener({});
    }
  });
}

beforeEach(() => {
  listeners.clear();
  for (const mock of Object.values(appInitBridge)) {
    mock.mockReset();
  }
  appInitBridge.on.mockImplementation((event: string, listener: EventListener) => {
    const eventListeners = listeners.get(event) ?? new Set<EventListener>();
    eventListeners.add(listener);
    listeners.set(event, eventListeners);
    return () => eventListeners.delete(listener);
  });
  appInitBridge.checkWorkspace.mockResolvedValue({
    hasWorkspace: true,
    path: "/workspace",
    workspaceRoot: "/workspace",
  });
  appInitBridge.getExtensionConfig.mockResolvedValue({
    yoloMode: false,
    autosave: true,
    useCtrlEnterToSend: false,
    enableNewConversationShortcut: false,
    showThinkingContent: true,
    showThinkingExpanded: false,
    version: "test",
  });
  appInitBridge.getSlashCommands.mockResolvedValue([]);
  appInitBridge.checkLoginStatus.mockResolvedValue({
    loggedIn: true,
    siteBase: "https://example.com",
  });
  appInitBridge.getModels.mockResolvedValue(INITIAL_CONFIG);
  useSettingsStore.getState().initModels(INITIAL_CONFIG.models, "plain", false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAppInit model catalog events", () => {
  it("refreshes a ready view without resetting a valid selection", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    appInitBridge.getModels.mockResolvedValue({
      models: [PLAIN_MODEL, NEW_MODEL],
      defaultModel: "new",
      defaultThinking: true,
    });

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.modelsCount).toBe(2);
    });
    expect(useSettingsStore.getState()).toMatchObject({
      models: [PLAIN_MODEL, NEW_MODEL],
      currentModel: "plain",
      thinkingEffort: "off",
      defaultModel: "new",
      defaultThinking: true,
    });
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(1);
  });

  it("reruns initialization outside ready and discards the old snapshot", async () => {
    let resolveOldModels!: (config: typeof INITIAL_CONFIG) => void;
    appInitBridge.getModels
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOldModels = resolve;
      }))
      .mockResolvedValue(INITIAL_CONFIG);
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(appInitBridge.getModels).toHaveBeenCalledTimes(1);
    });

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(appInitBridge.getModels).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveOldModels({
        models: [PLAIN_MODEL, NEW_MODEL],
        defaultModel: "new",
        defaultThinking: true,
      });
    });
    expect(result.current.modelsCount).toBe(1);
    expect(useSettingsStore.getState().models).toEqual([PLAIN_MODEL]);
  });

  it("uses the existing empty-model gate when a ready refresh returns no models", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    appInitBridge.getModels.mockResolvedValue({
      models: [],
      defaultModel: null,
      defaultThinking: false,
    });

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.status).toBe("no-models");
    });
    expect(result.current.modelsCount).toBe(0);
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(2);
  });

  it("keeps the current state and logs a failed model read", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    const error = new Error("read failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    appInitBridge.getModels.mockRejectedValue(error);

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("[AppInit] Failed to refresh models:", error);
    });
    expect(result.current).toMatchObject({ status: "ready", modelsCount: 1 });
    expect(useSettingsStore.getState().models).toEqual([PLAIN_MODEL]);
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(1);
  });
});
