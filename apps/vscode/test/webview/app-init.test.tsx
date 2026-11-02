import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appInitBridge = vi.hoisted(() => ({
  on: vi.fn(),
  checkWorkspace: vi.fn(),
  getExtensionConfig: vi.fn(),
  getSlashCommands: vi.fn(),
  checkLoginStatus: vi.fn(),
  getModels: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: appInitBridge,
  Events: {
    ExtensionConfigChanged: "extensionConfigChanged",
    ModelCatalogChanged: "modelCatalogChanged",
    StreamEvent: "streamEvent",
  },
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../webview-ui/src/components/Header", () => ({ Header: () => null }));
vi.mock("../../webview-ui/src/components/ChatArea", () => ({ ChatArea: () => null }));
vi.mock("../../webview-ui/src/components/inputarea/InputArea", () => ({ InputArea: () => null }));
vi.mock("../../webview-ui/src/components/MCPServersModal", () => ({ MCPServersModal: () => null }));
vi.mock("../../webview-ui/src/components/WorkDirModal", () => ({ WorkDirModal: () => null }));
vi.mock("../../webview-ui/src/components/ConfigErrorScreen", () => ({ ConfigErrorScreen: () => null }));
vi.mock("../../webview-ui/src/components/LoginScreen", () => ({ LoginScreen: () => null }));

import { useAppInit } from "../../webview-ui/src/hooks/useAppInit";
import { useSettingsStore } from "../../webview-ui/src/stores/settings.store";
import App from "../../webview-ui/src/App";

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
  appInitBridge.saveConfig.mockResolvedValue({ ok: true });
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

  it("ignores a catalog snapshot that predates a settings save", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    useSettingsStore.getState().initModels([PLAIN_MODEL, NEW_MODEL], "plain", false);
    let resolveModels!: (config: typeof INITIAL_CONFIG) => void;
    appInitBridge.getModels.mockReturnValueOnce(new Promise((resolve) => {
      resolveModels = resolve;
    }));
    await emitModelCatalogChanged();

    await act(async () => {
      useSettingsStore.getState().updateModel("new");
      resolveModels(INITIAL_CONFIG);
    });

    expect(useSettingsStore.getState()).toMatchObject({
      models: [PLAIN_MODEL, NEW_MODEL],
      currentModel: "new",
    });
  });

  it("ignores an older catalog read that finishes out of order", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    let resolveOldModels!: (config: typeof INITIAL_CONFIG) => void;
    appInitBridge.getModels
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOldModels = resolve;
      }))
      .mockResolvedValueOnce({
        models: [PLAIN_MODEL, NEW_MODEL],
        defaultModel: "new",
        defaultThinking: true,
      });

    await emitModelCatalogChanged();
    await emitModelCatalogChanged();
    await waitFor(() => {
      expect(result.current.modelsCount).toBe(2);
    });
    await act(async () => {
      resolveOldModels(INITIAL_CONFIG);
    });

    expect(result.current.modelsCount).toBe(2);
    expect(useSettingsStore.getState().models).toEqual([PLAIN_MODEL, NEW_MODEL]);
  });

  it("refreshes in place when login was skipped", async () => {
    appInitBridge.checkLoginStatus.mockResolvedValue({
      loggedIn: false,
      siteBase: "https://example.com",
    });
    const { result } = renderHook(() => useAppInit(true));
    await waitFor(() => {
      expect(result.current.status).toBe("not-logged-in");
    });
    appInitBridge.getModels.mockResolvedValue({
      models: [PLAIN_MODEL, NEW_MODEL],
      defaultModel: "plain",
      defaultThinking: false,
    });

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.modelsCount).toBe(2);
    });
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps an active login flow mounted during catalog refreshes", async () => {
    appInitBridge.checkLoginStatus.mockResolvedValue({
      loggedIn: false,
      siteBase: "https://example.com",
    });
    const { result } = renderHook(() => useAppInit(false, true));
    await waitFor(() => {
      expect(result.current.status).toBe("not-logged-in");
    });
    appInitBridge.getModels.mockResolvedValue({
      models: [PLAIN_MODEL, NEW_MODEL],
      defaultModel: "plain",
      defaultThinking: false,
    });

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.modelsCount).toBe(2);
    });
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("not-logged-in");
  });

  it("promotes a skipped empty-model view when models arrive", async () => {
    appInitBridge.getModels.mockResolvedValue({
      models: [],
      defaultModel: null,
      defaultThinking: false,
    });
    const { result } = renderHook(() => useAppInit(true));
    await waitFor(() => {
      expect(result.current.status).toBe("no-models");
    });
    appInitBridge.getModels.mockResolvedValue(INITIAL_CONFIG);

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.modelsCount).toBe(1);
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(1);
  });

  it("reruns the login gate when the refreshed default requires authentication", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    appInitBridge.checkLoginStatus.mockResolvedValue({
      loggedIn: false,
      siteBase: "https://example.com",
    });
    useSettingsStore.getState().setIsLoggedIn(false);

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(result.current.status).toBe("not-logged-in");
    });
    expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(2);
  });

  it("keeps the stream listener mounted when the catalog becomes empty", async () => {
    render(<App />);
    await waitFor(() => {
      expect(listeners.get("streamEvent")?.size).toBe(1);
    });
    appInitBridge.getModels.mockResolvedValue({
      models: [],
      defaultModel: null,
      defaultThinking: false,
    });

    await emitModelCatalogChanged();

    await waitFor(() => {
      expect(appInitBridge.checkWorkspace).toHaveBeenCalledTimes(2);
    });
    expect(listeners.get("streamEvent")?.size).toBe(1);
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
