/**
 * Scenario: a model refresh lands between Webview validation and the extension-host send.
 * Responsibilities: revalidate the requested alias against fresh host config and preserve fallback semantics.
 * Wiring: the real chat handler; VS Code, config, and the session runtime are replaced at their boundaries.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/chat-handler.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import { Methods } from "../shared/bridge";
import { chatHandlers } from "../src/handlers/chat.handler";
import type { HandlerContext } from "../src/handlers/types";

vi.mock("vscode", () => ({
  window: { activeTextEditor: undefined },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
}));

describe("Extension-host model validation before sending", () => {
  it("uses the fresh default when the submitted alias was removed", async () => {
    const getConfig = vi.fn().mockResolvedValue({
      providers: { "managed:kimi-code": { type: "kimi" } },
      defaultModel: "new-model",
      thinking: { enabled: true, effort: "low" },
      models: {
        "new-model": {
          provider: "managed:kimi-code",
          model: "new-model",
          displayName: "New Model",
          capabilities: ["thinking"],
          supportEfforts: ["low"],
          defaultEffort: "low",
        },
      },
    });
    const runtime = {
      id: "session-1",
      session: {
        getStatus: vi.fn().mockResolvedValue({ model: "new-model", thinkingEffort: "low", planMode: false }),
        setModel: vi.fn(),
        setThinking: vi.fn(),
        setPlanMode: vi.fn(),
      },
      announceSessionStart: vi.fn(),
      prompt: vi.fn().mockResolvedValue({ status: "finished" }),
    };
    const getOrCreateSession = vi.fn().mockResolvedValue(runtime);
    const ctx = {
      webviewId: "view-1",
      workDir: "/workspace",
      harness: { getConfig },
      getOrCreateSession,
      saveAllDirty: vi.fn(),
      broadcast: vi.fn(),
      logError: vi.fn(),
    } as unknown as HandlerContext;

    const result = await chatHandlers[Methods.StreamChat]!(
      { content: "hi", model: "removed-model", effort: "high" },
      ctx,
    );

    expect(result).toEqual({ done: true });
    expect(getOrCreateSession).toHaveBeenCalledWith("new-model", "low", undefined);
    expect(getConfig).toHaveBeenCalledWith({ reload: true });
  });

  it("does not create a session when the fresh catalog has no media-compatible fallback", async () => {
    const getOrCreateSession = vi.fn();
    const broadcast = vi.fn();
    const ctx = {
      webviewId: "view-1",
      workDir: "/workspace",
      harness: {
        getConfig: vi.fn().mockResolvedValue({
          defaultModel: "text-model",
          models: {
            "text-model": { provider: "managed:kimi-code", model: "text-model", capabilities: [] },
          },
        }),
      },
      getOrCreateSession,
      saveAllDirty: vi.fn(),
      broadcast,
      logError: vi.fn(),
    } as unknown as HandlerContext;

    const result = await chatHandlers[Methods.StreamChat]!(
      {
        content: "text follow-up",
        model: "removed-vision",
        effort: "off",
        mediaRequirements: { image: true, video: false },
      },
      ctx,
    );

    expect(result).toEqual({ done: false });
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      "streamEvent",
      {
        type: "error",
        code: "model.not_configured",
        message: "The selected model does not support these attachments. Choose another model before sending.",
        phase: "preflight",
      },
      "view-1",
    );
  });

  it("does not synthesize a fallback when the fresh config has no default", async () => {
    const getOrCreateSession = vi.fn();
    const broadcast = vi.fn();
    const ctx = {
      webviewId: "view-1",
      workDir: "/workspace",
      harness: {
        getConfig: vi.fn().mockResolvedValue({
          models: {
            "other-model": { provider: "other", model: "other-model", capabilities: [] },
          },
        }),
      },
      getOrCreateSession,
      saveAllDirty: vi.fn(),
      broadcast,
      logError: vi.fn(),
    } as unknown as HandlerContext;

    const result = await chatHandlers[Methods.StreamChat]!(
      { content: "hi", model: "removed-model", effort: "off" },
      ctx,
    );

    expect(result).toEqual({ done: false });
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      "streamEvent",
      {
        type: "error",
        code: "model.not_configured",
        message: "The selected model is no longer available. Choose another model before sending.",
        phase: "preflight",
      },
      "view-1",
    );
  });
});
