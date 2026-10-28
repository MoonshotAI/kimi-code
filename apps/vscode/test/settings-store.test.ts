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
    strict_thinking_validation: true,
  },
  {
    id: "always",
    name: "Always",
    provider: "managed:kimi-code",
    capabilities: ["always_thinking"],
    strict_thinking_validation: true,
  },
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

describe("Webview background model catalog synchronization", () => {
  it("adds new models without changing the current model or thinking effort", () => {
    useSettingsStore.getState().initModels(MODELS, "plain", false);
    useSettingsStore.setState({ currentModel: "reasoning", thinkingEffort: "low" });
    boundary.saveConfig.mockClear();

    useSettingsStore.getState().syncModels([
      ...MODELS,
      { id: "new-model", name: "New Model", provider: "managed:kimi-code", capabilities: [] },
    ], "plain", false);

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "reasoning",
      thinkingEffort: "low",
      defaultModel: "plain",
      modelsLoaded: true,
    });
    expect(useSettingsStore.getState().models.map((model) => model.id)).toContain("new-model");
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("keeps removed selection context without retaining it in the catalog", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    boundary.saveConfig.mockClear();

    useSettingsStore.getState().syncModels([MODELS[2]], "always", true);

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "reasoning",
      thinkingEffort: "high",
      defaultModel: "always",
      models: [MODELS[2]],
    });
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("follows a declared retirement replacement without resetting thinking effort", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    boundary.saveConfig.mockClear();
    const successor = {
      id: "successor",
      name: "Successor",
      provider: "managed:kimi-code",
      strict_thinking_validation: true,
      capabilities: ["thinking"],
      support_efforts: ["low", "high"],
      default_effort: "low",
    };

    useSettingsStore.getState().syncModels(
      [successor],
      "successor",
      false,
      undefined,
      { from: "reasoning", to: "successor" },
    );

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "successor",
      thinkingEffort: "high",
      defaultModel: "successor",
      models: [successor],
    });
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("normalizes an effort removed from the selected model's refreshed metadata", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    boundary.saveConfig.mockClear();
    const refreshed = { ...MODELS[1], support_efforts: ["low"], default_effort: "low" };

    useSettingsStore.getState().syncModels([refreshed], "reasoning", true, "low");

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "reasoning",
      thinkingEffort: "low",
      models: [refreshed],
    });
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("preserves an unlisted session effort for a permissive provider", () => {
    const permissive = {
      id: "permissive",
      name: "Permissive",
      provider: "openai",
      capabilities: ["thinking"],
      support_efforts: ["low", "high"],
      default_effort: "low",
      strict_thinking_validation: false,
    };
    useSettingsStore.getState().initModels([permissive], "permissive", true, "low");
    useSettingsStore.getState().setThinkingEffort("max");
    boundary.saveConfig.mockClear();

    useSettingsStore.getState().syncModels([permissive], "permissive", true, "low");

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "permissive",
      thinkingEffort: "max",
    });
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("normalizes effort when a retirement successor cannot use it", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    boundary.saveConfig.mockClear();
    const successor = {
      id: "successor",
      name: "Successor",
      provider: "managed:kimi-code",
      strict_thinking_validation: true,
      capabilities: [],
    };

    useSettingsStore.getState().syncModels(
      [successor],
      "successor",
      false,
      undefined,
      { from: "reasoning", to: "successor" },
    );

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "successor",
      thinkingEffort: "off",
      models: [successor],
    });
    expect(boundary.saveConfig).not.toHaveBeenCalled();
  });

  it("does not let a pending save rollback restore an unsupported effort", async () => {
    let rejectSave!: (error: Error) => void;
    boundary.saveConfig.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));
    useSettingsStore.getState().initModels(MODELS, "plain", true);
    useSettingsStore.getState().updateModel("reasoning");
    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "reasoning",
      thinkingEffort: "high",
    });
    const refreshed = { ...MODELS[1], support_efforts: ["low"], default_effort: "low" };
    useSettingsStore.getState().syncModels([refreshed], "reasoning", true, "low");
    expect(useSettingsStore.getState().thinkingEffort).toBe("low");

    rejectSave(new Error("stale save failed"));
    await Promise.resolve();

    expect(useSettingsStore.getState()).toMatchObject({
      currentModel: "reasoning",
      thinkingEffort: "low",
    });
    expect(boundary.toastError).not.toHaveBeenCalled();
  });

  it("does not cancel a pending save rollback when the selection is preserved", async () => {
    let rejectSave!: (error: Error) => void;
    boundary.saveConfig.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));
    useSettingsStore.getState().updateModel("reasoning");
    expect(useSettingsStore.getState().currentModel).toBe("reasoning");

    useSettingsStore.getState().syncModels(MODELS, "plain", false);
    rejectSave(new Error("config.toml is read-only"));

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().currentModel).toBe("plain");
    });
  });
});

describe("Webview model resolution before sending", () => {
  it("uses the valid default model when the current selection was removed", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([MODELS[2]], "always", true);

    useChatStore.getState().sendMessage("use fallback");

    expect(boundary.streamChat).toHaveBeenCalledWith(
      "use fallback",
      "always",
      "on",
      false,
      undefined,
      { image: false, video: false },
    );
  });

  it("normalizes effort against the fallback model instead of the removed selection", () => {
    const fallback = {
      id: "fallback",
      name: "Fallback",
      provider: "managed:kimi-code",
      capabilities: ["thinking"],
      support_efforts: ["low"],
      default_effort: "low",
      strict_thinking_validation: true,
    };
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([fallback], "fallback", true, "low");
    useChatStore.setState({ sessionId: "session-1" });

    useChatStore.getState().sendMessage("normalize fallback effort");

    expect(boundary.streamChat).toHaveBeenCalledWith(
      "normalize fallback effort",
      "fallback",
      "low",
      false,
      "session-1",
      { image: false, video: false },
    );
  });

  it("does not send or pick an arbitrary remaining model when the default is also missing", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([MODELS[2]], null, false);

    useChatStore.getState().sendMessage("keep for retry");

    expect(boundary.streamChat).not.toHaveBeenCalled();
    expect(useChatStore.getState()).toMatchObject({
      isStreaming: false,
      pendingInput: { content: "keep for retry", model: "reasoning" },
    });
    expect(boundary.toastError).toHaveBeenCalledWith(
      "The selected model is no longer available. Choose another model before sending.",
    );
  });

  it("blocks attachments when the fallback model lacks media capabilities", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([MODELS[0]], "plain", false);
    const dataUri = "data:image/png;base64,AA";
    useChatStore.getState().addDraftMedia("image-1", dataUri);

    useChatStore.getState().sendMessage("image attached");

    expect(boundary.streamChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().draftMedia).toEqual([{ id: expect.any(String), dataUri }]);
    expect(boundary.toastError).toHaveBeenCalledWith(
      "The selected model does not support these attachments. Choose another model before sending.",
    );
  });

  it("includes conversation media when resolving a queued fallback", () => {
    const vision = { id: "vision", name: "Vision", provider: "managed:kimi-code", capabilities: ["image_in"] };
    useSettingsStore.getState().initModels([vision, MODELS[0]], "vision", false);
    useChatStore.setState({
      messages: [{
        id: "history-image",
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
        timestamp: 1,
      }],
    });
    const chat = useChatStore.getState();
    chat.enqueue("text follow-up", "vision");
    useSettingsStore.getState().syncModels([MODELS[0]], "plain", false);

    chat.sendNextQueued();

    expect(boundary.streamChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(useChatStore.getState().pendingInput).toEqual({ content: "text follow-up", model: "vision" });
  });

  it("passes conversation media requirements to the extension host", () => {
    const vision = { id: "vision", name: "Vision", provider: "managed:kimi-code", capabilities: ["image_in"] };
    useSettingsStore.getState().initModels([vision], "vision", false);
    useChatStore.setState({
      messages: [{
        id: "history-image",
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
        timestamp: 1,
      }],
    });

    useChatStore.getState().sendMessage("text follow-up");

    expect(boundary.streamChat).toHaveBeenCalledWith(
      "text follow-up",
      "vision",
      "off",
      false,
      undefined,
      { image: true, video: false },
    );
  });

  it("keeps prior history and the current input when no history-compatible model remains", () => {
    const vision = { id: "vision", name: "Vision", provider: "managed:kimi-code", capabilities: ["image_in"] };
    useSettingsStore.getState().initModels([vision, MODELS[0]], "vision", false);
    useChatStore.setState({
      messages: [{
        id: "history-image",
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
        timestamp: 1,
      }],
    });
    useSettingsStore.getState().syncModels([MODELS[0]], "plain", false);

    useChatStore.getState().sendMessage("direct follow-up");

    expect(boundary.streamChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().pendingInput).toEqual({ content: "direct follow-up", model: "vision" });
  });

  it("keeps queued messages in order when no valid model remains", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([MODELS[2]], null, false);
    const chat = useChatStore.getState();
    chat.enqueue("first", "reasoning");
    chat.enqueue("second", "reasoning");

    chat.sendNextQueued();

    expect(boundary.streamChat).not.toHaveBeenCalled();
    expect(useChatStore.getState()).toMatchObject({
      isStreaming: false,
      pendingInput: { content: "first", model: "reasoning" },
    });
    expect(useChatStore.getState().queue.map((item) => item.content)).toEqual(["first", "second"]);
  });

  it("keeps an attachment queued when the fallback lacks media capabilities", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([MODELS[0]], "plain", false);
    const content = [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,AA" } }];
    useChatStore.getState().enqueue(content, "reasoning");

    useChatStore.getState().sendNextQueued();

    expect(boundary.streamChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(useChatStore.getState().pendingInput).toEqual({ content, model: "reasoning" });
    expect(boundary.toastError).toHaveBeenCalledWith(
      "The selected model does not support these attachments. Choose another model before sending.",
    );
  });

  it("continues the queue with a valid default model", () => {
    useSettingsStore.getState().initModels(MODELS, "reasoning", true, "high");
    useSettingsStore.getState().syncModels([MODELS[2]], "always", true);
    useChatStore.getState().enqueue("queued", "reasoning");

    useChatStore.getState().sendNextQueued();

    expect(boundary.streamChat).toHaveBeenCalledWith(
      "queued",
      "always",
      "on",
      false,
      undefined,
      { image: false, video: false },
    );
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it("keeps the failed and remaining prompts when host model preflight rejects a queued send", () => {
    useSettingsStore.getState().initModels(MODELS, "plain", false);
    const chat = useChatStore.getState();
    chat.enqueue("first", "plain");
    chat.enqueue("second", "plain");
    vi.useFakeTimers();

    try {
      chat.sendNextQueued();
      useChatStore.getState().processEvent({
        type: "error",
        code: "model.not_configured",
        message: "The selected model is no longer available. Choose another model before sending.",
        phase: "preflight",
      });
      vi.advanceTimersByTime(100);

      expect(boundary.streamChat).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().pendingInput).toEqual({ content: "first", model: "plain" });
      expect(useChatStore.getState().queue.map((item) => item.content)).toEqual(["second"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Webview MCP update bridge", () => {
  it("sends a lossless structured MCP edit request to the extension host", async () => {
    const posted: unknown[] = [];
    let receiveMessage: ((event: { data: unknown }) => void) | undefined;
    vi.stubGlobal("document", {
      body: { dataset: { webviewid: "mcp-test-view" } },
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

  it("seeds the top tier when it is the model's delivered default", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(MODELS, "reasoning", false);

    useSettingsStore.getState().selectThinkingEffort("high");

    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "reasoning", thinking: true, effort: "high" });
    expect(useSettingsStore.getState().defaultThinkingEffort).toBe("high");
  });

  it("does not seed a pick above the model's delivered default", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels([
      {
        id: "reasoning",
        name: "Reasoning",
        provider: "managed:kimi-code",
        capabilities: ["thinking"],
        support_efforts: ["low", "high", "max"],
        default_effort: "low",
      },
    ], "reasoning", false);

    useSettingsStore.getState().selectThinkingEffort("high");

    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "reasoning", thinking: true, effort: "high" });
    expect(useSettingsStore.getState().defaultThinkingEffort).toBeUndefined();
  });

  it("does not seed the top tier when the model declares no default", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels([
      {
        id: "reasoning",
        name: "Reasoning",
        provider: "managed:kimi-code",
        capabilities: ["thinking"],
        support_efforts: ["low", "high"],
      },
    ], "reasoning", false);

    useSettingsStore.getState().selectThinkingEffort("high");

    expect(useSettingsStore.getState().thinkingEffort).toBe("high");
    expect(boundary.saveConfig).toHaveBeenCalledWith({ model: "reasoning", thinking: true, effort: "high" });
    expect(useSettingsStore.getState().defaultThinkingEffort).toBeUndefined();
  });

  const SWITCH_MODELS = [
    {
      id: "seeded",
      name: "Seeded",
      provider: "managed:kimi-code",
      capabilities: ["thinking"],
      support_efforts: ["low", "medium"],
      default_effort: "medium",
    },
    {
      id: "max-default",
      name: "Max Default",
      provider: "managed:kimi-code",
      capabilities: ["thinking"],
      support_efforts: ["low", "max"],
      default_effort: "max",
    },
  ];

  it("updates the seed when a model switch persists the derived effort", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    useSettingsStore.getState().initModels(SWITCH_MODELS, "seeded", true, "medium");

    // "medium" is unsupported here, so the switch derives the model default
    // "max"; with the delivered default at the top tier the host persists it.
    useSettingsStore.getState().updateModel("max-default");

    expect(useSettingsStore.getState().thinkingEffort).toBe("max");
    expect(boundary.saveConfig).toHaveBeenCalledWith({
      model: "max-default",
      thinking: true,
      effort: "max",
      effortChanged: true,
    });
    expect(useSettingsStore.getState().defaultThinkingEffort).toBe("max");
  });

  it("rolls the seed back when the model-switch save fails", async () => {
    let rejectSave!: (error: Error) => void;
    boundary.saveConfig.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));
    useSettingsStore.getState().initModels(SWITCH_MODELS, "seeded", true, "medium");

    useSettingsStore.getState().updateModel("max-default");
    expect(useSettingsStore.getState().defaultThinkingEffort).toBe("max");

    rejectSave(new Error("config.toml is read-only"));
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().defaultThinkingEffort).toBe("medium");
    });
  });

  it("leaves the seed alone when the switch re-confirms the active effort", () => {
    boundary.saveConfig.mockResolvedValue({ ok: true });
    // No persisted effort: the seed starts undefined and the session derives
    // "max" from the model default.
    useSettingsStore.getState().initModels([
      ...SWITCH_MODELS,
      {
        id: "max-default-b",
        name: "Max Default B",
        provider: "managed:kimi-code",
        capabilities: ["thinking"],
        support_efforts: ["low", "max"],
        default_effort: "max",
      },
    ], "max-default", true);

    // The derived effort equals the active one, so the host leaves the stored
    // preference untouched — the seed must not invent one either.
    useSettingsStore.getState().updateModel("max-default-b");

    expect(useSettingsStore.getState().thinkingEffort).toBe("max");
    expect(boundary.saveConfig).toHaveBeenCalledWith({
      model: "max-default-b",
      thinking: true,
      effort: "max",
      effortChanged: false,
    });
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
