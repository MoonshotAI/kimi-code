/**
 * Scenario: untrusted Webview RPC messages cross into the VS Code extension host.
 * Responsibilities: validate requests, preserve public model metadata, omit private paths, and recover visibly from persisted state errors.
 * Wiring: the real BridgeHandler and handlers; VS Code and the engine harness boundary are replaced.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/bridge-handler.test.ts
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderCatalogRef, UndoRef } from "@moonshot-ai/agent-core";
import { sanitizeWorkDirKey } from "@moonshot-ai/kimi-code-sdk";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as vscode from "vscode";

import { Methods } from "../shared/bridge";
import { BridgeHandler } from "../src/bridge-handler";
import { createFakeEngineSession, type FakeEngineSession } from "./fake-engine-session";

const CAPABILITY = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
};

const host = vi.hoisted(() => {
  const watcher = {
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  };
  const configData: Record<string, unknown> = {};
  const catalog = {
    providerIds: [] as string[],
    info: {} as Record<string, { aliasScope?: string }>,
    modelsByProvider: {} as Record<string, Array<Record<string, unknown>>>,
  };
  const catalogFacade = {
    providers: () => catalog.providerIds,
    providerInfo: (providerId: string) => catalog.info[providerId],
    models: (providerId: string) => catalog.modelsByProvider[providerId] ?? [],
  };
  const harness = {
    homeDir: "/tmp/kimi-code-test-home",
    close: vi.fn(async () => undefined),
    listSessions: vi.fn(async (): Promise<readonly { id: string; metadata?: Record<string, unknown> }[]> => []),
    resumeSession: vi.fn(),
    forkSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    config: {
      get: vi.fn((name: string) => configData[name]),
      set: vi.fn(async (name: string, value: unknown) => {
        configData[name] = value;
      }),
      reload: vi.fn(async () => undefined),
    },
    app: {
      resolve: vi.fn((token: unknown) => {
        if (token === ProviderCatalogRef) return catalogFacade;
        throw new Error("unknown token");
      }),
      space: {
        get: vi.fn(
          async (): Promise<{ id: string; metadata?: Record<string, unknown> } | undefined> =>
            undefined,
        ),
      },
      updateSession: vi.fn(async (id: string, patch: { metadata?: Record<string, unknown> }) => ({
        id,
        metadata: patch.metadata,
      })),
    },
  };
  const showWarningMessage = vi.fn(async () => undefined as string | undefined);

  class Uri {
    readonly scheme = "file";
    readonly authority = "";
    readonly path: string;

    constructor(readonly fsPath: string) {
      this.path = fsPath;
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(join(base.fsPath, ...segments));
    }

    toString(): string {
      return `file://${this.path}`;
    }
  }

  return {
    Uri,
    watcher,
    harness,
    catalog,
    configData,
    createKimiHarness: vi.fn(async (_options?: unknown) => harness),
    showWarningMessage,
    workspaceFolders: [] as Array<{ uri: Uri }>,
  };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  workspace: {
    get workspaceFolders() {
      return host.workspaceFolders;
    },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    createFileSystemWatcher: () => host.watcher,
    textDocuments: [],
  },
  window: { showWarningMessage: host.showWarningMessage },
}));

vi.mock("@moonshot-ai/kimi-code-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@moonshot-ai/kimi-code-sdk")>();
  return {
    ...original,
    createKimiHarness: (options: unknown) => host.createKimiHarness(options),
  };
});

let bridge: BridgeHandler;
let root: string;
let homeDir: string;
let showLogs: Mock<() => void>;
let writeLog: Mock<(message: string) => void>;
let workspaceState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kimi-vscode-bridge-"));
  homeDir = await mkdtemp(join(tmpdir(), "kimi-vscode-home-"));
  vi.stubEnv("KIMI_CODE_HOME", homeDir);
  host.harness.homeDir = homeDir;
  host.workspaceFolders.splice(0, host.workspaceFolders.length, { uri: new host.Uri(root) });
  showLogs = vi.fn();
  writeLog = vi.fn();
  for (const key of Object.keys(host.configData)) delete host.configData[key];
  host.catalog.providerIds = [];
  host.catalog.info = {};
  host.catalog.modelsByProvider = {};
  host.harness.resumeSession.mockReset();
  host.harness.listSessions.mockReset();
  host.harness.listSessions.mockResolvedValue([]);
  host.harness.forkSession.mockReset();
  host.harness.deleteSession.mockClear();
  host.harness.config.get.mockClear();
  host.harness.config.set.mockClear();
  host.harness.app.space.get.mockReset();
  host.harness.app.space.get.mockResolvedValue(undefined);
  host.harness.app.updateSession.mockClear();
  host.createKimiHarness.mockImplementation(async () => host.harness);
  host.showWarningMessage.mockReset();
  host.showWarningMessage.mockResolvedValue(undefined);
  workspaceState = { get: vi.fn((_key, fallback) => fallback), update: vi.fn() };
  bridge = new BridgeHandler(
    vi.fn(),
    workspaceState as unknown as vscode.Memento,
    join(root, "global-storage"),
    vi.fn(),
    showLogs,
    writeLog,
  );
});

afterEach(async () => {
  await bridge.dispose();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

async function markSessionDir(workDir: string): Promise<void> {
  await mkdir(join(homeDir, "sessions-v3", sanitizeWorkDirKey(workDir)), { recursive: true });
}

describe("Engine startup", () => {
  it("surfaces the harness failure on the first engine call", async () => {
    host.createKimiHarness.mockRejectedValueOnce(new Error("engine boom"));

    const result = await bridge.handle({ id: "rpc-1", method: Methods.GetModels }, "view-1");

    expect(result).toEqual({ id: "rpc-1", error: "engine boom" });
    expect(writeLog).toHaveBeenCalledWith(expect.stringContaining("engine boom"));
  });
});

describe("Webview RPC boundary (validates requests before host dispatch)", () => {
  it("returns a readable error when the envelope is not a plain object", async () => {
    const result = await bridge.handle([], "view-1");

    expect(result).toEqual({
      id: "",
      error: "Invalid bridge request: expected a plain object.",
    });
  });

  it("does not execute a known handler when the request id is blank", async () => {
    const result = await bridge.handle({ id: " ", method: Methods.ShowLogs }, "view-1");

    expect(result).toEqual({
      id: "",
      error: "Invalid bridge request: id must be a non-empty string.",
    });
    expect(showLogs).not.toHaveBeenCalled();
  });

  it("reports aborted: false when the view has no runtime to cancel", async () => {
    const result = await bridge.handle({ id: "rpc-1", method: Methods.AbortChat }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: { aborted: false } });
  });

  it("cancels the view's runtime when aborting a chat", async () => {
    const cancel = vi.fn(async () => undefined);
    vi.spyOn(bridge.runtime, "getSessionForView").mockReturnValue({ cancel } as never);

    const result = await bridge.handle({ id: "rpc-1", method: Methods.AbortChat }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: { aborted: true } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["missingMethod", "toString", "constructor", "__proto__"])(
    "does not dispatch the unknown or prototype method %s",
    async (method) => {
      const result = await bridge.handle({ id: "rpc-1", method }, "view-1");

      expect(result).toEqual({ id: "rpc-1", error: `Unknown bridge method: ${method}` });
      expect(showLogs).not.toHaveBeenCalled();
    },
  );

  it("does not execute a no-params handler when a payload is supplied", async () => {
    const result = await bridge.handle(
      { id: "rpc-1", method: Methods.ShowLogs, params: {} },
      "view-1",
    );

    expect(result).toEqual({
      id: "rpc-1",
      error: "Invalid bridge params for method: showLogs",
    });
    expect(showLogs).not.toHaveBeenCalled();
  });

  it("does not execute an object-payload handler when a required field has the wrong type", async () => {
    const result = await bridge.handle(
      { id: "rpc-1", method: Methods.AddInputHistory, params: { text: 42 } },
      "view-1",
    );

    expect(result).toEqual({
      id: "rpc-1",
      error: "Invalid bridge params for method: addInputHistory",
    });
    expect(workspaceState.update).not.toHaveBeenCalled();
  });

  it("dispatches a valid request through the existing bridge surface", async () => {
    const result = await bridge.handle({ id: "rpc-1", method: Methods.ShowLogs }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: { ok: true } });
    expect(showLogs).toHaveBeenCalledOnce();
  });

  it("keeps provider identity when configured models share a display name", async () => {
    host.configData["defaultModel"] = "openai/shared";
    host.catalog.providerIds = ["openai", "company-proxy"];
    host.catalog.modelsByProvider = {
      openai: [{ id: "shared", provider: "openai", name: "shared", displayName: "Shared", maxContextSize: 128_000, capability: CAPABILITY }],
      "company-proxy": [{ id: "shared", provider: "company-proxy", name: "shared", displayName: "Shared", maxContextSize: 128_000, capability: CAPABILITY }],
    };

    const result = await bridge.handle({ id: "rpc-models", method: Methods.GetModels }, "view-1");

    expect(result).toMatchObject({
      id: "rpc-models",
      result: {
        defaultModel: "openai/shared",
        models: [
          { id: "openai/shared", name: "Shared", provider: "openai" },
          { id: "company-proxy/shared", name: "Shared", provider: "company-proxy" },
        ],
      },
    });
  });

  it("preserves adaptive thinking metadata in the Webview model list", async () => {
    host.catalog.providerIds = ["anthropic"];
    host.catalog.modelsByProvider = {
      anthropic: [{
        id: "claude-sonnet",
        provider: "anthropic",
        name: "claude-sonnet",
        maxContextSize: 200_000,
        thinking: { adaptiveThinking: true },
        capability: CAPABILITY,
      }],
    };

    const result = await bridge.handle({ id: "rpc-models", method: Methods.GetModels }, "view-1");

    expect(result).toMatchObject({
      result: {
        models: [{
          id: "anthropic/claude-sonnet",
          name: "claude-sonnet",
          provider: "anthropic",
          adaptive_thinking: true,
        }],
      },
    });
  });

  it("does not expose the session storage path when listing sessions", async () => {
    await markSessionDir(root);
    host.harness.listSessions.mockResolvedValueOnce([
      { id: "session-1", metadata: undefined },
    ]);

    const result = await bridge.handle(
      { id: "rpc-1", method: Methods.GetKimiSessions },
      "view-1",
    );

    expect(result).toEqual({
      id: "rpc-1",
      result: [{ id: "session-1", workDir: root, updatedAt: 0, brief: "" }],
    });
    expect(JSON.stringify(result)).not.toContain("/private/kimi/sessions");
  });

  it("does not expose the session storage path when forking a session", async () => {
    await markSessionDir(root);
    host.harness.listSessions.mockResolvedValue([{ id: "session-1", metadata: undefined }]);
    host.harness.forkSession.mockResolvedValueOnce(createForkSession("session-2").session);
    host.harness.app.space.get.mockResolvedValue({ id: "session-2", metadata: undefined });

    const result = await bridge.handle(
      {
        id: "rpc-1",
        method: Methods.ForkKimiSession,
        params: { sessionId: "session-1", turnIndex: 0 },
      },
      "view-1",
    );

    expect(result).toEqual({ id: "rpc-1", result: { sessionId: "session-2" } });
    expect(JSON.stringify(result)).not.toContain("/private/kimi/sessions");
  });

  it("runs a fork through the active session cancellation boundary", async () => {
    await markSessionDir(root);
    const runExclusiveAfterCancelling = vi.fn(async <T>(action: () => Promise<T>) => action());
    vi.spyOn(bridge.runtime, "getSession").mockReturnValue({
      runExclusiveAfterCancelling,
    } as never);
    host.harness.listSessions.mockResolvedValue([{ id: "session-1", metadata: undefined }]);
    host.harness.forkSession.mockResolvedValueOnce(createForkSession("session-2").session);
    host.harness.app.space.get.mockResolvedValue({ id: "session-2", metadata: undefined });

    const result = await bridge.handle(
      {
        id: "rpc-1",
        method: Methods.ForkKimiSession,
        params: { sessionId: "session-1", turnIndex: 0 },
      },
      "view-1",
    );

    expect(result).toEqual({ id: "rpc-1", result: { sessionId: "session-2" } });
    expect(runExclusiveAfterCancelling).toHaveBeenCalledOnce();
    expect(host.harness.forkSession).toHaveBeenCalledOnce();
  });

  it("closes and removes a fork when its baseline cannot be materialized", async () => {
    await markSessionDir(root);
    const fork = createForkSession("session-2");
    host.harness.listSessions.mockResolvedValue([{ id: "session-1", metadata: undefined }]);
    host.harness.forkSession.mockResolvedValueOnce(fork.session);
    host.harness.app.space.get.mockResolvedValue({ id: "session-2", metadata: undefined });
    vi.spyOn(bridge.baselineManager, "materializeToFork").mockRejectedValueOnce(
      new Error("baseline unavailable"),
    );
    const deleteBaseline = vi.spyOn(bridge.baselineManager, "deleteSession");

    const result = await bridge.handle(
      {
        id: "rpc-1",
        method: Methods.ForkKimiSession,
        params: { sessionId: "session-1", turnIndex: 0 },
      },
      "view-1",
    );

    expect(result).toEqual({ id: "rpc-1", error: "baseline unavailable" });
    expect(fork.closeCount()).toBe(1);
    expect(host.harness.deleteSession).toHaveBeenCalledWith("session-2");
    expect(deleteBaseline).toHaveBeenCalledWith("session-2");
  });

  it("keeps conversation history available when its baseline snapshot disappears", async () => {
    const engine = createFakeEngineSession("session-1");
    host.harness.resumeSession.mockResolvedValueOnce(engine.session);
    host.harness.app.space.get.mockResolvedValue({
      id: "session-1",
      metadata: { vscode_legacy_approval: { yolo: false, afk: false } },
    });
    host.showWarningMessage.mockResolvedValueOnce("Show Logs");
    const sourcePath = join(root, "app.ts");
    await writeFile(sourcePath, "original\n", "utf-8");
    await bridge.baselineManager.capture(
      { id: "session-1", workDir: root, metadata: { source: "test" } },
      sourcePath,
    );
    const baselinesRoot = join(root, "global-storage", "baselines");
    const [homeDirectory] = await readdir(baselinesRoot);
    const [sessionDirectory] = await readdir(join(baselinesRoot, homeDirectory!));
    const snapshotsDirectory = join(
      baselinesRoot,
      homeDirectory!,
      sessionDirectory!,
      "snapshots",
    );
    const [snapshot] = await readdir(snapshotsDirectory);
    await rm(join(snapshotsDirectory, snapshot!));

    const result = await bridge.handle(
      {
        id: "rpc-1",
        method: Methods.LoadKimiSessionHistory,
        params: { kimiSessionId: "session-1" },
      },
      "view-1",
    );

    expect(result).toEqual({
      id: "rpc-1",
      result: expect.arrayContaining([
        expect.objectContaining({ type: "StatusUpdate", _sessionId: "session-1" }),
      ]),
    });
    expect(writeLog).toHaveBeenCalledWith(
      expect.stringMatching(/Unable to restore session file changes.*Unable to read baseline snapshot/),
    );
    await vi.waitFor(() => expect(showLogs).toHaveBeenCalledOnce());
  });

  it("returns a readable error when persisted session state is corrupt without wedging the bridge", async () => {
    host.harness.resumeSession.mockRejectedValueOnce(
      new Error("Session state is invalid JSON at line 4"),
    );

    const failed = await bridge.handle(
      {
        id: "rpc-1",
        method: Methods.LoadKimiSessionHistory,
        params: { kimiSessionId: "session-1" },
      },
      "view-1",
    );
    const next = await bridge.handle({ id: "rpc-2", method: Methods.ShowLogs }, "view-1");

    expect(failed).toEqual({
      id: "rpc-1",
      error: "Session state is invalid JSON at line 4",
    });
    expect(writeLog).toHaveBeenCalledWith(
      expect.stringContaining("Session state is invalid JSON at line 4"),
    );
    expect(next).toEqual({ id: "rpc-2", result: { ok: true } });
  });
});

describe("Registered working directories", () => {
  it("lists the workspace root when there is no session history", async () => {
    const result = await bridge.handle({ id: "rpc-1", method: Methods.GetRegisteredWorkDirs }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: [root] });
  });

  it("keeps the selected working directory visible without session history", async () => {
    const sub = join(root, "packages", "demo");
    await mkdir(sub, { recursive: true });

    await bridge.handle({ id: "rpc-1", method: Methods.SetWorkDir, params: { workDir: sub } }, "view-1");
    const result = await bridge.handle({ id: "rpc-2", method: Methods.GetRegisteredWorkDirs }, "view-1");

    expect(result).toEqual({ id: "rpc-2", result: [root, sub].toSorted() });
  });

  it("merges session-history directories across workspace work directories", async () => {
    const inside = join(root, "nested");
    await mkdir(inside, { recursive: true });
    await markSessionDir(root);
    await markSessionDir(inside);
    host.harness.listSessions.mockResolvedValue([{ id: "s-1", metadata: undefined }]);
    await bridge.handle({ id: "rpc-0", method: Methods.SetWorkDir, params: { workDir: inside } }, "view-1");

    const result = await bridge.handle({ id: "rpc-1", method: Methods.GetRegisteredWorkDirs }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: [inside, root].toSorted() });
    expect(JSON.stringify(result)).not.toContain("/private/outside");
  });
});

describe("Webview config saves (thinking effort persistence parity with the TUI)", () => {
  const reasoningModel = {
    id: "reasoning",
    provider: "managed:kimi-code",
    name: "reasoning",
    thinking: { supportEfforts: ["low", "high", "max"], defaultEffort: "high" },
    capability: CAPABILITY,
  };

  function mockCatalog(defaultEffort = "high") {
    host.configData["defaultModel"] = "kimi/reasoning";
    host.catalog.providerIds = ["managed:kimi-code"];
    host.catalog.info = { "managed:kimi-code": { aliasScope: "kimi" } };
    host.catalog.modelsByProvider = {
      "managed:kimi-code": [{ ...reasoningModel, thinking: { ...reasoningModel.thinking, defaultEffort } }],
    };
  }

  it("persists a non-top effort as the global default", async () => {
    mockCatalog();

    const result = await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "high" } },
      "view-1",
    );

    expect(result).toEqual({ id: "rpc-1", result: { ok: true } });
    expect(host.harness.config.set).toHaveBeenCalledWith("defaultModel", "kimi/reasoning", "user");
    expect(host.harness.config.set).toHaveBeenCalledWith("thinking", { enabled: true, effort: "high" }, "user");
  });

  it("keeps a pick above the model's delivered default session-only", async () => {
    mockCatalog();

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "max" } },
      "view-1",
    );

    expect(host.harness.config.set).toHaveBeenCalledWith("thinking", { enabled: true }, "user");
  });

  it("persists the top tier when the model's delivered default is the top tier", async () => {
    mockCatalog("max");

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "max" } },
      "view-1",
    );

    expect(host.harness.config.set).toHaveBeenCalledWith("thinking", { enabled: true, effort: "max" }, "user");
  });

  it("persists the concrete effort when the model's levels are unknown", async () => {
    host.catalog.providerIds = [];

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "custom/model", thinking: true, effort: "max" } },
      "view-1",
    );

    expect(host.harness.config.set).toHaveBeenCalledWith("defaultModel", "custom/model", "user");
    expect(host.harness.config.set).toHaveBeenCalledWith("thinking", { enabled: true, effort: "max" }, "user");
  });

  it("leaves the stored effort alone when the pick re-confirms the active effort", async () => {
    mockCatalog();
    host.configData["thinking"] = { enabled: false, effort: "low" };

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "high", effortChanged: false } },
      "view-1",
    );

    expect(host.harness.config.set).toHaveBeenCalledWith("defaultModel", "kimi/reasoning", "user");
    expect(host.harness.config.set).toHaveBeenCalledWith("thinking", { enabled: true }, "user");
  });

  it("skips the config write entirely when nothing changed", async () => {
    mockCatalog();
    host.configData["thinking"] = { enabled: true, effort: "high" };

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "high" } },
      "view-1",
    );

    expect(host.harness.config.set).not.toHaveBeenCalled();
  });
});

function createForkSession(id: string): FakeEngineSession {
  const engine = createFakeEngineSession(id);
  engine.main.facades.set(UndoRef, {
    availability: () => ({ maxTurns: 1, stoppedAtCompaction: false }),
    undo: vi.fn(async () => 0),
  });
  return engine;
}
