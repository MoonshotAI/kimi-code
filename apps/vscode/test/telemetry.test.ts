/**
 * Scenario: the extension host joins the shared v1 telemetry pipeline under a three-layer consent gate.
 * Responsibilities: initialize the shared client with extension identity, apply the VS Code global
 * telemetry switch dynamically, emit first_launch on device-id minting, and shut down with a short timeout.
 * Wiring: the real composition root; VS Code, kimi-telemetry, oauth, and SDK config/auth boundaries are mocked.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/telemetry.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const state = {
    isTelemetryEnabled: true,
    telemetryListener: undefined as ((enabled: boolean) => void) | undefined,
    deviceIdFirstLaunch: false,
    configTelemetry: undefined as boolean | undefined,
    configModel: "kimi-k2",
    accessToken: "token-1" as string | null,
    staticallyEnabled: true,
  };
  return {
    state,
    createKimiDeviceId: vi.fn((_homeDir: string, options?: { onFirstLaunch?: () => void }) => {
      if (state.deviceIdFirstLaunch) options?.onFirstLaunch?.();
      return "device-1";
    }),
    initializeTelemetry: vi.fn(),
    setTelemetryEnabled: vi.fn(),
    shouldEnableTelemetry: vi.fn(() => host.state.staticallyEnabled),
    track: vi.fn(),
    shutdownTelemetry: vi.fn(async () => undefined),
    installCrashHandlers: vi.fn(),
    resolveKimiRegion: vi.fn(() => "global" as const),
    loadRuntimeConfigSafe: vi.fn(() => ({
      config: {
        telemetry: host.state.configTelemetry,
        defaultModel: host.state.configModel,
        providers: {
          "managed:kimi-code": { oauth: { key: "oauth/kimi-code-global", oauthHost: "https://auth.kimi.ai" } },
        },
      },
    })),
    resolveConfigPath: vi.fn(() => "/kimi-home/config.toml"),
    resolveKimiHome: vi.fn(() => "/kimi-home"),
    getCachedAccessToken: vi.fn(async () => host.state.accessToken),
  };
});

vi.mock("vscode", () => ({
  env: {
    get isTelemetryEnabled() {
      return host.state.isTelemetryEnabled;
    },
    onDidChangeTelemetryEnabled: vi.fn((listener: (enabled: boolean) => void) => {
      host.state.telemetryListener = listener;
      return { dispose: vi.fn() };
    }),
  },
}));

vi.mock("@moonshot-ai/kimi-telemetry", () => ({
  initializeTelemetry: host.initializeTelemetry,
  setTelemetryEnabled: host.setTelemetryEnabled,
  shouldEnableTelemetry: host.shouldEnableTelemetry,
  shutdownTelemetry: host.shutdownTelemetry,
  track: host.track,
  installCrashHandlers: host.installCrashHandlers,
}));

vi.mock("@moonshot-ai/kimi-code-oauth", () => ({
  createKimiDeviceId: host.createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME: "managed:kimi-code",
  KIMI_REGION_PROFILES: {
    "mainland-cn": { telemetryEndpoint: "https://telemetry-logs.example.com/v1/event" },
    global: { telemetryEndpoint: "https://telemetry-logs.example.net/v1/event" },
  },
  resolveKimiRegion: host.resolveKimiRegion,
}));

vi.mock("@moonshot-ai/kimi-code-sdk", () => ({
  KimiAuthFacade: class {
    getCachedAccessToken = host.getCachedAccessToken;
  },
  loadRuntimeConfigSafe: host.loadRuntimeConfigSafe,
  resolveConfigPath: host.resolveConfigPath,
  resolveKimiHome: host.resolveKimiHome,
}));

import {
  activateExtensionTelemetry,
  deactivateExtensionTelemetry,
} from "../src/telemetry";

function activate() {
  return activateExtensionTelemetry({ version: "1.2.3", log: vi.fn() });
}

function initializeOptions() {
  const call = host.initializeTelemetry.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (call === undefined) throw new Error("initializeTelemetry was not called");
  return call;
}

describe("extension telemetry composition root", () => {
  beforeEach(() => {
    host.state.isTelemetryEnabled = true;
    host.state.telemetryListener = undefined;
    host.state.deviceIdFirstLaunch = false;
    host.state.configTelemetry = undefined;
    host.state.configModel = "kimi-k2";
    host.state.accessToken = "token-1";
    host.state.staticallyEnabled = true;
    vi.clearAllMocks();
  });

  it("initializes the shared stack with extension identity and the config gate", async () => {
    activate();

    const options = initializeOptions();
    expect(options).toMatchObject({
      homeDir: "/kimi-home",
      deviceId: "device-1",
      enabled: true,
      initiallyEnabled: true,
      appName: "kimi-code-vscode",
      version: "1.2.3",
      uiMode: "vscode",
      model: "kimi-k2",
    });
    expect(options["endpoint"]).toBeTypeOf("function");
    expect(options["getAccessToken"]).toBeTypeOf("function");
    await expect((options["getAccessToken"] as () => Promise<string | null>)()).resolves.toBe("token-1");
    expect(host.shouldEnableTelemetry).toHaveBeenCalledWith({ enabled: true });
  });

  it("maps config telemetry=false to the static gate", () => {
    host.state.configTelemetry = false;

    activate();

    expect(initializeOptions()["enabled"]).toBe(false);
    expect(host.shouldEnableTelemetry).toHaveBeenCalledWith({ enabled: false });
  });

  it("resolves the endpoint through the region resolver per flush", () => {
    activate();

    const endpoint = initializeOptions()["endpoint"] as () => string;
    expect(endpoint()).toBe("https://telemetry-logs.example.net/v1/event");
    expect(host.resolveKimiRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredOAuthHost: "https://auth.kimi.ai",
        configuredOAuthKey: "oauth/kimi-code-global",
        homeDir: "/kimi-home",
      }),
    );
  });

  it("passes the VS Code global switch as the initial intake state", () => {
    host.state.isTelemetryEnabled = false;

    activate();

    expect(initializeOptions()["initiallyEnabled"]).toBe(false);
    expect(host.setTelemetryEnabled).not.toHaveBeenCalled();
  });

  it("follows live changes of the VS Code global switch", () => {
    activate();
    const listener = host.state.telemetryListener;
    if (listener === undefined) throw new Error("no telemetry listener registered");

    listener(false);
    expect(host.setTelemetryEnabled).toHaveBeenLastCalledWith(false);
    listener(true);
    expect(host.setTelemetryEnabled).toHaveBeenLastCalledWith(true);
  });

  it("ignores live changes when the static gates are closed", () => {
    host.state.staticallyEnabled = false;

    activate();
    host.state.telemetryListener?.(true);

    expect(host.setTelemetryEnabled).not.toHaveBeenCalled();
  });

  it("emits first_launch when the device id is minted", () => {
    host.state.deviceIdFirstLaunch = true;

    activate();

    expect(host.track).toHaveBeenCalledWith("first_launch");
  });

  it("does not emit first_launch for an existing device id", () => {
    activate();

    expect(host.track).not.toHaveBeenCalled();
  });

  it("never installs crash handlers in the shared extension host", () => {
    activate();

    expect(host.installCrashHandlers).not.toHaveBeenCalled();
  });

  it("shuts down with a short timeout on deactivate", async () => {
    await deactivateExtensionTelemetry();

    expect(host.shutdownTelemetry).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });
});
