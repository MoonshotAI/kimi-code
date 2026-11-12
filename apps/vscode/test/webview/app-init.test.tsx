import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  on: vi.fn(),
  checkWorkspace: vi.fn(),
  getExtensionConfig: vi.fn(),
  getSlashCommands: vi.fn(),
  checkLoginStatus: vi.fn(),
  getModels: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge,
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

const PLAIN_MODEL = { id: "plain", name: "Plain", provider: "managed:kimi-code", capabilities: [] };
const NEW_MODEL = { id: "new", name: "New", provider: "managed:kimi-code", capabilities: [] };
const INITIAL_CONFIG = { models: [PLAIN_MODEL], defaultModel: "plain", defaultThinking: false };
const listeners = new Map<string, Set<(data: unknown) => void>>();

async function emitCatalogChanged(): Promise<void> {
  await act(async () => {
    for (const listener of [...(listeners.get("modelCatalogChanged") ?? [])]) listener({});
  });
}

beforeEach(() => {
  listeners.clear();
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.on.mockImplementation((event: string, listener: (data: unknown) => void) => {
    const eventListeners = listeners.get(event) ?? new Set<(data: unknown) => void>();
    eventListeners.add(listener);
    listeners.set(event, eventListeners);
    return () => eventListeners.delete(listener);
  });
  bridge.checkWorkspace.mockResolvedValue({ hasWorkspace: true, path: "/workspace", workspaceRoot: "/workspace" });
  bridge.getExtensionConfig.mockResolvedValue({
    yoloMode: false,
    autosave: true,
    useCtrlEnterToSend: false,
    enableNewConversationShortcut: false,
    showThinkingContent: true,
    showThinkingExpanded: false,
    version: "test",
  });
  bridge.getSlashCommands.mockResolvedValue([]);
  bridge.checkLoginStatus.mockResolvedValue({ loggedIn: true, siteBase: "https://example.com" });
  bridge.getModels.mockResolvedValue(INITIAL_CONFIG);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAppInit model catalog events", () => {
  it("ignores a stale read that completes after a newer catalog read", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let resolveFirst!: (config: typeof INITIAL_CONFIG) => void;
    bridge.getModels
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        models: [PLAIN_MODEL, NEW_MODEL],
        defaultModel: "new",
        defaultThinking: false,
      });

    await emitCatalogChanged();
    await emitCatalogChanged();
    await waitFor(() => expect(useSettingsStore.getState().models).toHaveLength(2));
    await act(async () => resolveFirst(INITIAL_CONFIG));

    expect(useSettingsStore.getState().models).toHaveLength(2);
  });

  it("reads fresh config on the next manual refresh", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await emitCatalogChanged();
    bridge.getModels.mockResolvedValue({
      models: [PLAIN_MODEL, NEW_MODEL],
      defaultModel: "new",
      defaultThinking: false,
    });

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(useSettingsStore.getState().models).toHaveLength(2);
  });

  it("uses the applied catalog count during initialization", async () => {
    let resolveInitial!: (config: { models: never[]; defaultModel: null; defaultThinking: boolean }) => void;
    bridge.getModels.mockReturnValueOnce(new Promise((resolve) => {
      resolveInitial = resolve;
    }));
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => expect(bridge.getModels).toHaveBeenCalledTimes(1));
    bridge.getModels.mockResolvedValueOnce({
      models: [PLAIN_MODEL],
      defaultModel: "plain",
      defaultThinking: false,
    });

    await emitCatalogChanged();
    await act(async () => resolveInitial({
      models: [],
      defaultModel: null,
      defaultThinking: false,
    }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("does not let initial loading overwrite a newer catalog", async () => {
    let resolveInitial!: (config: typeof INITIAL_CONFIG) => void;
    bridge.getModels.mockReturnValueOnce(new Promise((resolve) => {
      resolveInitial = resolve;
    }));
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => expect(bridge.getModels).toHaveBeenCalledTimes(1));
    bridge.getModels.mockResolvedValueOnce({
      models: [PLAIN_MODEL, NEW_MODEL],
      defaultModel: "new",
      defaultThinking: false,
    });

    await emitCatalogChanged();
    await waitFor(() => expect(useSettingsStore.getState().models).toHaveLength(2));
    await act(async () => resolveInitial(INITIAL_CONFIG));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(useSettingsStore.getState().models).toHaveLength(2);
  });
});
