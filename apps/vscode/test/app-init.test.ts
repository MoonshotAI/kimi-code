// @vitest-environment jsdom
/**
 * Scenario: App-level view routing after init, across login state transitions.
 * Responsibilities: the sign-in screen must stay reachable from every state — in
 * particular the no-models state (a managed OAuth token exists but config.toml
 * has no models, e.g. a first login whose model provisioning failed after the
 * device flow already persisted the token), where Reload alone can never change
 * the on-disk state and the user would otherwise be stranded.
 * Wiring: resolveAppView is pure; the bridge and toast boundaries are mocked away.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/app-init.test.ts
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  listeners: new Map<string, (data: unknown) => void>(),
  on: vi.fn(),
  checkWorkspace: vi.fn(),
  getExtensionConfig: vi.fn(),
  getSlashCommands: vi.fn(),
  checkLoginStatus: vi.fn(),
  getModels: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: {
    on: boundary.on,
    checkWorkspace: boundary.checkWorkspace,
    getExtensionConfig: boundary.getExtensionConfig,
    getSlashCommands: boundary.getSlashCommands,
    checkLoginStatus: boundary.checkLoginStatus,
    getModels: boundary.getModels,
  },
  Events: {
    ExtensionConfigChanged: "extensionConfigChanged",
    ModelCatalogChanged: "modelCatalogChanged",
  },
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import {
  resolveAppView,
  useAppInit,
  type AppStatus,
} from "../webview-ui/src/hooks/useAppInit";

const { useSettingsStore } = await import("../webview-ui/src/stores/settings.store");

beforeEach(() => {
  boundary.listeners.clear();
  boundary.on.mockReset().mockImplementation((event: string, handler: (data: unknown) => void) => {
    boundary.listeners.set(event, handler);
    return () => boundary.listeners.delete(event);
  });
  boundary.checkWorkspace.mockReset().mockResolvedValue({ hasWorkspace: true, workspaceRoot: "/workspace" });
  boundary.getExtensionConfig.mockReset().mockResolvedValue({});
  boundary.getSlashCommands.mockReset().mockResolvedValue([]);
  boundary.checkLoginStatus.mockReset().mockResolvedValue({ loggedIn: true });
  boundary.getModels.mockReset().mockResolvedValue({
    defaultModel: null,
    defaultThinking: false,
    models: [],
  });
  useSettingsStore.getState().initModels([], null, false);
  useSettingsStore.getState().setIsLoggedIn(false);
});

afterEach(() => {
  cleanup();
});

function resolve(
  status: AppStatus,
  options: { modelsCount?: number; skippedLogin?: boolean; showLogin?: boolean } = {},
) {
  return resolveAppView({
    status,
    modelsCount: options.modelsCount ?? 0,
    skippedLogin: options.skippedLogin ?? false,
    showLogin: options.showLogin ?? false,
  });
}

describe("resolveAppView", () => {
  it("routes a brand-new user (no token, no models) to the login screen", () => {
    expect(resolve("not-logged-in")).toEqual({ view: "login" });
  });

  it("routes a skipped login without models to no-models with a sign-in path", () => {
    expect(resolve("not-logged-in", { skippedLogin: true })).toEqual({
      view: "status",
      status: "no-models",
      canGoToLogin: true,
    });
  });

  it("routes a skipped login with models to the main view", () => {
    expect(resolve("not-logged-in", { skippedLogin: true, modelsCount: 2 })).toEqual({
      view: "main",
    });
  });

  it("keeps a sign-in path in the no-models trap (token without model config)", () => {
    // Regression: this state previously rendered "Model setup required" with only
    // a Reload button, making the login screen unreachable for affected users.
    expect(resolve("no-models")).toEqual({
      view: "status",
      status: "no-models",
      canGoToLogin: true,
    });
  });

  it("routes to the login screen when the user asks for it from any state", () => {
    expect(resolve("no-models", { showLogin: true })).toEqual({ view: "login" });
    expect(resolve("ready", { showLogin: true, modelsCount: 1 })).toEqual({ view: "login" });
  });

  it("routes a no-models user who skips again back to no-models with a sign-in path", () => {
    expect(resolve("no-models", { skippedLogin: true })).toEqual({
      view: "status",
      status: "no-models",
      canGoToLogin: true,
    });
  });

  it("routes ready to the main view", () => {
    expect(resolve("ready", { modelsCount: 1 })).toEqual({ view: "main" });
  });

  it("routes non-login error statuses to status screens without a sign-in path", () => {
    for (const status of ["loading", "no-workspace", "runtime-error"] as const) {
      expect(resolve(status)).toEqual({ view: "status", status, canGoToLogin: false });
    }
  });
});

describe("useAppInit model catalog events", () => {
  it("enters the ready state when a background refresh provides the first models", async () => {
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("no-models");
    });

    const config = {
      defaultModel: "new-model",
      defaultThinking: false,
      models: [
        { id: "new-model", name: "New Model", provider: "managed:kimi-code", capabilities: [] },
      ],
    };
    const listener = boundary.listeners.get("modelCatalogChanged");
    expect(listener).toBeTypeOf("function");
    act(() => listener?.({ config }));

    expect(result.current).toMatchObject({ status: "ready", modelsCount: 1 });
    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "new-model",
      thinkingEffort: "off",
    });
  });

  it("keeps the current selection visible when its catalog entry disappears without replacement", async () => {
    const initialModel = {
      id: "current-model",
      name: "Current Model",
      provider: "managed:kimi-code",
      capabilities: ["thinking"],
    };
    boundary.getModels.mockResolvedValue({
      defaultModel: initialModel.id,
      defaultThinking: true,
      models: [initialModel],
    });
    const { result } = renderHook(() => useAppInit());
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const listener = boundary.listeners.get("modelCatalogChanged");
    expect(listener).toBeTypeOf("function");
    act(() => listener?.({
      config: { defaultModel: null, defaultThinking: false, models: [] },
      retiredDefault: undefined,
    }));

    expect(result.current).toMatchObject({ status: "ready", modelsCount: 1 });
    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: initialModel.id,
      thinkingEffort: "on",
      models: [initialModel],
    });
  });
});
