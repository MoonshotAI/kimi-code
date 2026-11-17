import { describe, expect, it, vi } from "vitest";

vi.mock("@/services", () => ({
  bridge: {},
  Events: {},
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { resolveAppView, type AppStatus } from "../webview-ui/src/hooks/useAppInit";

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
