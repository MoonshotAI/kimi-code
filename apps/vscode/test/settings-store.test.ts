/**
 * Scenario: Webview state crosses the VS Code bridge during settings changes, MCP edits, and chat failures.
 * Responsibilities: model metadata and selections remain provider-aware; MCP edits stay lossless; chat errors recover visibly.
 * Wiring: the real Zustand store and MCP bridge; settings saves, toast, and the VS Code messaging API are the only replaced boundaries.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/settings-store.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MCP_SECRET_MASK } from "../shared/legacy-sdk";

const boundary = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  streamChat: vi.fn(),
  abortChat: vi.fn(),
  trackFiles: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: {
    saveConfig: boundary.saveConfig,
    streamChat: boundary.streamChat,
    abortChat: boundary.abortChat,
    trackFiles: boundary.trackFiles,
  },
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: boundary.toastError, warning: boundary.toastWarning },
}));

import {
  getMediaFallbackModel,
  getModelThinkingMode,
  groupModelsByProvider,
  requiresManagedProviderLogin,
  useSettingsStore,
} from "../webview-ui/src/stores/settings.store";
import { useChatStore } from "../webview-ui/src/stores/chat.store";

const MODELS = [
  { id: "plain", name: "Plain", provider: "managed:kimi-code", capabilities: [] },
  {
    id: "reasoning",
    name: "Reasoning",
    provider: "managed:kimi-code",
    capabilities: ["thinking"],
    support_efforts: ["low", "high"],
    default_effort: "high",
  },
  { id: "always", name: "Always", provider: "managed:kimi-code", capabilities: ["always_thinking"] },
];

beforeEach(() => {
  boundary.saveConfig.mockReset();
  boundary.streamChat.mockReset();
  boundary.streamChat.mockResolvedValue({ done: false });
  boundary.abortChat.mockReset();
  boundary.abortChat.mockResolvedValue({ aborted: true });
  boundary.trackFiles.mockReset();
  boundary.toastError.mockReset();
  boundary.toastWarning.mockReset();
  useSettingsStore.getState().initModels(MODELS, "plain", false);
  useChatStore.setState({
    sessionId: null,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    handshakeReceived: false,
    draftMedia: [],
    lastStatus: null,
    tokenUsage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    activeTokenUsage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    pendingInput: null,
    queue: [],
    pendingQuestion: null,
    planMode: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Webview model settings persistence", () => {
  it("persists the selected alias when display names collide across providers", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels([
      { id: "openai/shared", name: "Shared", provider: "openai", capabilities: [] },
      { id: "proxy/shared", name: "Shared", provider: "company-proxy", capabilities: [] },
    ], "openai/shared", false);

    useSettingsStore.getState().updateModel("proxy/shared");

    expect(boundary.saveConfig).toHaveBeenCalledWith({
      model: "proxy/shared",
      thinking: false,
      effort: "off",
      effortChanged: false,
    });
  });

  it("rolls back the optimistic model selection when saving fails", async () => {
    let rejectSave!: (error: Error) => void;
    boundary.saveConfig.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));

    useSettingsStore.getState().updateModel("reasoning");
    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "reasoning",
      thinkingEffort: "off",
    });

    rejectSave(new Error("config.toml is read-only"));
    await vi.waitFor(() => {
      expect(useSettingsStore.getState()).toMatchObject({
        currentModel: "plain",
        thinkingEffort: "off",
      });
    });
    expect(boundary.toastError).toHaveBeenCalledWith(
      "Failed to save model settings: config.toml is read-only",
    );
  });

  it("does not let an older failed save overwrite a newer selection", async () => {
    let rejectFirst!: (error: Error) => void;
    boundary.saveConfig
      .mockReturnValueOnce(new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValueOnce({ ok: true });

    useSettingsStore.getState().updateModel("reasoning");
    useSettingsStore.getState().updateModel("always");
    rejectFirst(new Error("older request failed"));
    await Promise.resolve();

    expect(useSettingsStore.getState().currentModel).toBe("always");
    expect(boundary.toastError).not.toHaveBeenCalled();
  });
});

describe("Webview model metadata", () => {
  it("keeps same-named models in separate provider groups", () => {
    const groups = groupModelsByProvider([
      { id: "kimi/shared", name: "Shared", provider: "managed:kimi-code", capabilities: [] },
      { id: "proxy/shared", name: "Shared", provider: "company-proxy", capabilities: [] },
    ]);

    expect(groups.map((group) => ({
      provider: group.provider,
      label: group.label,
      models: group.models.map((model) => model.id),
    }))).toEqual([
      { provider: "company-proxy", label: "company-proxy", models: ["proxy/shared"] },
      { provider: "managed:kimi-code", label: "Kimi Code", models: ["kimi/shared"] },
    ]);
  });

  it("offers a thinking toggle when a model declares adaptive thinking", () => {
    expect(getModelThinkingMode({
      id: "anthropic/claude",
      name: "Claude",
      provider: "anthropic",
      capabilities: [],
      adaptive_thinking: true,
    })).toBe("switch");
  });

  it("prefers a compatible model from the current provider for media fallback", () => {
    const current = {
      id: "openai/text",
      name: "Text",
      provider: "openai",
      capabilities: [],
    };
    const fallback = getMediaFallbackModel([
      { id: "other/vision", name: "Vision A", provider: "other", capabilities: ["image_in"] },
      { id: "openai/vision", name: "Vision B", provider: "openai", capabilities: ["image_in"] },
    ], current);

    expect(fallback?.id).toBe("openai/vision");
  });

  it("does not require Kimi login when the default model uses a custom provider", () => {
    expect(requiresManagedProviderLogin([
      { id: "local/model", name: "Local", provider: "local", capabilities: [] },
    ], "local/model", false)).toBe(false);
  });

  it("requires Kimi login when the default model uses the managed provider", () => {
    expect(requiresManagedProviderLogin([
      { id: "kimi/model", name: "Kimi", provider: "managed:kimi-code", capabilities: [] },
    ], "kimi/model", false)).toBe(true);
  });
});

describe("Webview MCP update bridge", () => {
  it("sends a lossless structured MCP edit request to the extension host", async () => {
    const posted: unknown[] = [];
    let receiveMessage: ((event: { data: unknown }) => void) | undefined;
    vi.stubGlobal("document", {
      body: { getAttribute: () => "mcp-test-view" },
    });
    vi.stubGlobal("window", {
      addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => {
        receiveMessage = listener;
      },
    });
    vi.stubGlobal("acquireVsCodeApi", () => ({
      postMessage: (message: { id: string }) => {
        posted.push(message);
        queueMicrotask(() => receiveMessage?.({ data: { id: message.id, result: [] } }));
      },
      getState: () => undefined,
      setState: () => undefined,
    }));
    vi.resetModules();
    const { bridge } = await import("../webview-ui/src/services/bridge");

    await bridge.updateMCPServer("old-name", {
      name: "new-name",
      transport: "stdio",
      command: "C:\\Program Files\\Example MCP\\server.exe",
      args: ["--config", "C:\\Users\\Example User\\mcp config.json"],
      env: { SERVICE_TOKEN: MCP_SECRET_MASK, DEBUG: "1" },
    });

    expect(posted).toEqual([
      expect.objectContaining({
        method: "updateMCPServer",
        webviewId: "mcp-test-view",
        params: {
          originalName: "old-name",
          server: {
            name: "new-name",
            transport: "stdio",
            command: "C:\\Program Files\\Example MCP\\server.exe",
            args: ["--config", "C:\\Users\\Example User\\mcp config.json"],
            env: { SERVICE_TOKEN: MCP_SECRET_MASK, DEBUG: "1" },
          },
        },
      }),
    ]);
  });
});

describe("Webview chat error recovery", () => {
  it("stops the pending state and keeps the input available when session setup fails", () => {
    useChatStore.getState().sendMessage("retry this request");

    useChatStore.getState().processEvent({
      type: "error",
      code: "session.state_invalid",
      message: "Session data is invalid.",
      detail: "state.json: Unexpected token at line 4",
      phase: "preflight",
    });

    expect(useChatStore.getState()).toMatchObject({
      isStreaming: false,
      isCompacting: false,
      pendingInput: { content: "retry this request", model: "plain" },
    });
  });

  it("stops the response and retains provider detail when a running turn fails", () => {
    useChatStore.getState().sendMessage("start a turn");
    useChatStore.getState().processEvent({
      type: "TurnBegin",
      payload: { user_input: "start a turn" },
    });
    useChatStore.getState().processEvent({ type: "StepBegin", payload: { n: 1 } });

    useChatStore.getState().processEvent({
      type: "error",
      code: "provider.api_error",
      message: "Service temporarily unavailable.",
      detail: "HTTP 400: function name is invalid",
      phase: "runtime",
    });

    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages.at(-1)?.inlineError).toEqual({
      code: "provider.api_error",
      message: "Service temporarily unavailable.",
      detail: "HTTP 400: function name is invalid",
    });
  });
});

describe("Webview thinking mode parity with the TUI", () => {
  it("derives thinking modes from metadata only, mirroring the TUI rules", () => {
    const base = { id: "m", name: "M", provider: "p", capabilities: [] as string[] };
    expect(getModelThinkingMode({ ...base, capabilities: ["thinking"], support_efforts: ["low", "high"] })).toBe("effort");
    expect(getModelThinkingMode({ ...base, capabilities: ["always_thinking"] })).toBe("always");
    expect(getModelThinkingMode({ ...base, capabilities: ["thinking"] })).toBe("switch");
    expect(getModelThinkingMode({ ...base, adaptive_thinking: true })).toBe("switch");
    expect(getModelThinkingMode({ ...base, name: "Kimi Thinking Pro" })).toBe("none");
    expect(getModelThinkingMode(base)).toBe("none");
  });
});

describe("Webview thinking effort parity with the TUI", () => {
  it("resolves a boolean \"on\" to the model default for effort-capable models", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", false);

    useSettingsStore.getState().selectThinkingEffort("on");

    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "reasoning", thinking: true, effort: "high" });
  });

  it("prefers the persisted configured effort when resolving \"on\"", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", false);
    useSettingsStore.setState({ defaultThinkingEffort: "low" });

    useSettingsStore.getState().selectThinkingEffort("on");

    expect(useSettingsStore.getState().thinkingEffort).toBe("low");
  });

  it("keeps \"on\" for genuine boolean models", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels([
      { id: "bool", name: "Bool", provider: "openai", capabilities: ["thinking"] },
    ], "bool", false);

    useSettingsStore.getState().selectThinkingEffort("on");

    expect(useSettingsStore.getState().thinkingEffort).toBe("on");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "bool", thinking: true, effort: "on" });
  });

  it("persists disabling thinking with thinking false", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", true);

    useSettingsStore.getState().selectThinkingEffort("off");

    expect(useSettingsStore.getState().thinkingEffort).toBe("off");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "reasoning", thinking: false, effort: "off" });
  });

  it("rejects \"off\" for always-on effort models", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels([
      { id: "always-effort", name: "AE", provider: "openai", capabilities: ["always_thinking"], support_efforts: ["low", "high"] },
    ], "always-effort", true);
    const previous = useSettingsStore.getState().thinkingEffort;
    boundary.saveConfig.mockClear();

    useSettingsStore.getState().selectThinkingEffort("off");

    expect(useSettingsStore.getState().thinkingEffort).toBe(previous);
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("rejects efforts outside support_efforts", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", false);
    const previous = useSettingsStore.getState().thinkingEffort;
    boundary.saveConfig.mockClear();

    useSettingsStore.getState().selectThinkingEffort("ultra");

    expect(useSettingsStore.getState().thinkingEffort).toBe(previous);
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("skips the config write when re-confirming the current effort", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", true);
    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    boundary.saveConfig.mockClear();

    useSettingsStore.getState().selectThinkingEffort("high");

    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("does not seed future sessions with the model's top declared tier", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", false);

    useSettingsStore.getState().selectThinkingEffort("high");

    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "reasoning", thinking: true, effort: "high" });
    expect(useSettingsStore.getState().defaultThinkingEffort).toBeUndefined();
  });

  it("seeds future sessions with a persisted non-top effort", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", false);

    useSettingsStore.getState().selectThinkingEffort("low");

    expect(useSettingsStore.getState().thinkingEffort).toBe("low");
    expect(useSettingsStore.getState().defaultThinkingEffort).toBe("low");
  });

  it("marks the effort as changed when a model switch resolves to a different effort", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", true);
    expect(useSettingsStore.getState().thinkingEffort).toBe("high");

    useSettingsStore.getState().updateModel("always");

    expect(useSettingsStore.getState().thinkingEffort).toBe("on");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "always", thinking: true, effort: "on", effortChanged: true });
  });
});

describe("Webview mid-turn warnings", () => {
  it("shows a non-terminal error as a toast without unlocking the composer", async () => {
    useChatStore.getState().sendMessage("first message");
    useChatStore.getState().sendMessage("queued follow-up");
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().queue).toHaveLength(1);

    useChatStore.getState().processEvent({
      type: "error",
      code: "internal",
      message: "Internal error occurred.",
      detail: "A response is already being generated for this session.",
      phase: "runtime",
      terminal: false,
    });

    // The turn is still running: nothing unlocks, nothing flushes, nothing is retried.
    expect(boundary.toastWarning).toHaveBeenCalledWith("Internal error occurred.");
    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(true);
    expect(state.queue).toHaveLength(1);
    expect(state.pendingInput).not.toBeNull();
    expect(state.messages.at(-1)?.inlineError).toBeUndefined();

    // The genuine terminal still completes the turn and flushes the queue.
    useChatStore.getState().processEvent({ type: "stream_complete", result: { status: "finished" } });
    expect(useChatStore.getState().isStreaming).toBe(false);
    await vi.waitFor(() => {
      expect(boundary.streamChat).toHaveBeenCalledTimes(2);
    });
  });
});
