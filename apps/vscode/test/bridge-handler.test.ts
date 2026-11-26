import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as vscode from "vscode";

import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE as OAUTH_REVOKED_MESSAGE } from "@moonshot-ai/kimi-code-oauth";
import { Events, Methods } from "../shared/bridge";
import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from "../shared/errors";
import { BridgeHandler } from "../src/bridge-handler";

const host = vi.hoisted(() => {
  const watcher = {
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  };
  const harness = {
    homeDir: "/tmp/kimi-code-test-home",
    close: vi.fn(async () => undefined),
    getConfig: vi.fn(),
    setConfig: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    listWorkspaceSkills: vi.fn(),
    resumeSession: vi.fn(),
    forkSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    auth: {
      status: vi.fn(async () => ({
        providers: [{ providerName: "managed:kimi-code", hasToken: true }],
      })),
      logout: vi.fn(async () => ({ providerName: "managed:kimi-code", ok: true })),
      getAccountProfile: vi.fn(),
      switchWorkspace: vi.fn(),
    },
  };
  const showWarningMessage = vi.fn(async () => undefined as string | undefined);
  const executeCommand = vi.fn(async () => undefined);
  const track = vi.fn();

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
    createKimiHarness: vi.fn(() => harness),
    showWarningMessage,
    executeCommand,
    track,
    workspaceFolders: [] as Array<{ uri: Uri }>,
  };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  env: { remoteName: undefined },
  commands: { executeCommand: host.executeCommand },
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

vi.mock("@moonshot-ai/kimi-telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@moonshot-ai/kimi-telemetry")>();
  return {
    ...original,
    track: host.track,
  };
});

vi.mock("@moonshot-ai/kimi-code-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@moonshot-ai/kimi-code-sdk")>();
  return {
    ...original,
    createKimiHarness: () => host.createKimiHarness(),
  };
});

let bridge: BridgeHandler;
let root: string;
let broadcast: Mock<(event: string, data: unknown, webviewId?: string) => void>;
let showLogs: Mock<() => void>;
let writeLog: Mock<(message: string) => void>;
let workspaceState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kimi-vscode-bridge-"));
  host.workspaceFolders.splice(0, host.workspaceFolders.length, { uri: new host.Uri(root) });
  broadcast = vi.fn();
  showLogs = vi.fn();
  writeLog = vi.fn();
  host.harness.resumeSession.mockReset();
  host.harness.getConfig.mockReset();
  host.harness.getConfig.mockResolvedValue({ models: {} });
  host.harness.auth.status.mockReset();
  host.harness.auth.status.mockResolvedValue({
    providers: [{ providerName: "managed:kimi-code", hasToken: true }],
  });
  host.harness.auth.logout.mockReset();
  host.harness.auth.logout.mockResolvedValue({ providerName: "managed:kimi-code", ok: true });
  host.harness.auth.getAccountProfile.mockReset();
  host.harness.auth.switchWorkspace.mockReset();
  host.track.mockReset();
  host.createKimiHarness.mockImplementation(() => host.harness);
  host.showWarningMessage.mockReset();
  host.showWarningMessage.mockResolvedValue(undefined);
  workspaceState = { get: vi.fn((_key, fallback) => fallback), update: vi.fn() };
  bridge = new BridgeHandler(
    broadcast,
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
});

describe("Engine startup", () => {
  function constructBridge(): void {
    new BridgeHandler(
      vi.fn(),
      workspaceState as unknown as vscode.Memento,
      join(root, "global-storage-2"),
      vi.fn(),
      showLogs,
      writeLog,
    );
  }

  it("surfaces the failure when the engine cannot start", () => {
    host.createKimiHarness.mockImplementationOnce(() => {
      throw new Error("engine boom");
    });

    expect(constructBridge).toThrow(/^Failed to start the Kimi engine: engine boom\.$/);
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

  it("deduplicates same-name workspace skills using the default-first listing", async () => {
    host.harness.listWorkspaceSkills.mockResolvedValueOnce([
      { name: "review", description: "from A", path: "/work/A/review/SKILL.md", source: "project", workspaceDir: "/work/A" },
      { name: "review", description: "from B", path: "/work/B/review/SKILL.md", source: "project", workspaceDir: "/work/B" },
    ]);

    const response = await bridge.handle({ id: "rpc-skills", method: Methods.GetSlashCommands }, "view-1");
    const commands = (response as { result: Array<{ name: string; aliases: string[]; description: string }> }).result
      .filter((command) => command.name.startsWith("skill:"));

    expect(commands).toEqual([
      { name: "skill:review", aliases: [], description: "from A" },
    ]);
    expect(host.harness.listWorkspaceSkills).toHaveBeenCalledOnce();
  });

  it("keeps provider identity when configured models share a display name", async () => {
    host.harness.getConfig.mockResolvedValueOnce({
      defaultModel: "openai/shared",
      models: {
        "openai/shared": {
          provider: "openai",
          model: "shared",
          displayName: "Shared",
          maxContextSize: 128_000,
        },
        "proxy/shared": {
          provider: "company-proxy",
          model: "shared",
          displayName: "Shared",
          maxContextSize: 128_000,
        },
      },
    });

    const result = await bridge.handle({ id: "rpc-models", method: Methods.GetModels }, "view-1");

    expect(result).toMatchObject({
      id: "rpc-models",
      result: {
        defaultModel: "openai/shared",
        models: [
          { id: "openai/shared", name: "Shared", provider: "openai" },
          { id: "proxy/shared", name: "Shared", provider: "company-proxy" },
        ],
      },
    });
  });

  it("preserves adaptive thinking metadata and tolerates a missing model name", async () => {
    host.harness.getConfig.mockResolvedValueOnce({
      defaultModel: "anthropic/claude",
      models: {
        "anthropic/claude": {
          provider: "anthropic",
          model: "claude-sonnet",
          maxContextSize: 200_000,
          adaptiveThinking: true,
        },
      },
    });

    const result = await bridge.handle({ id: "rpc-models", method: Methods.GetModels }, "view-1");

    expect(result).toMatchObject({
      result: {
        models: [{
          id: "anthropic/claude",
          name: "claude-sonnet",
          provider: "anthropic",
          adaptive_thinking: true,
        }],
      },
    });

    host.harness.getConfig.mockResolvedValueOnce({
      defaultModel: "custom/missing",
      models: {
        "custom/missing": { provider: "custom", maxContextSize: 200_000 },
      },
    } as never);
    await expect(
      bridge.handle({ id: "rpc-models", method: Methods.GetModels }, "view-1"),
    ).resolves.toMatchObject({
      id: "rpc-models",
      result: { models: [{ id: "custom/missing" }] },
    });
  });

  it("resolves the fallback-profile default effort with the provider type", async () => {
    host.harness.getConfig.mockResolvedValueOnce({
      defaultModel: "custom/claude",
      providers: {
        custom: { type: "anthropic", apiKey: "test-key" },
      },
      models: {
        "custom/claude": {
          provider: "custom",
          model: "claude-latest",
          supportEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    });

    const result = await bridge.handle({ id: "rpc-models", method: Methods.GetModels }, "view-1");

    expect(result).toMatchObject({
      result: {
        models: [{
          id: "custom/claude",
          support_efforts: ["low", "medium", "high", "xhigh", "max"],
          default_effort: "high",
        }],
      },
    });
  });

  it("does not expose the session storage path when listing sessions", async () => {
    host.harness.listSessions.mockResolvedValueOnce([
      {
        id: "session-1",
        workDir: root,
        sessionDir: "/private/kimi/sessions/session-1",
        updatedAt: 123,
        title: "Visible title",
      },
    ] as never);

    const result = await bridge.handle(
      { id: "rpc-1", method: Methods.GetKimiSessions },
      "view-1",
    );

    expect(result).toEqual({
      id: "rpc-1",
      result: [{ id: "session-1", workDir: root, updatedAt: 123, brief: "Visible title" }],
    });
    expect(JSON.stringify(result)).not.toContain("/private/kimi/sessions");
  });

  it("does not expose the session storage path when forking a session", async () => {
    const source = {
      id: "session-1",
      workDir: root,
      sessionDir: "/private/kimi/sessions/session-1",
      updatedAt: 123,
    };
    const target = {
      id: "session-2",
      workDir: root,
      sessionDir: "/private/kimi/sessions/session-2",
      updatedAt: 124,
    };
    host.harness.listSessions.mockResolvedValueOnce([source] as never);
    host.harness.forkSession.mockResolvedValueOnce({ summary: target, close: vi.fn() });

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
    const source = {
      id: "session-1",
      workDir: root,
      sessionDir: "/private/kimi/sessions/session-1",
      updatedAt: 123,
    };
    const target = {
      id: "session-2",
      workDir: root,
      sessionDir: "/private/kimi/sessions/session-2",
      updatedAt: 124,
    };
    const runExclusiveAfterCancelling = vi.fn(async <T>(action: () => Promise<T>) => action());
    vi.spyOn(bridge.runtime, "getSession").mockReturnValue({
      runExclusiveAfterCancelling,
    } as never);
    host.harness.listSessions.mockResolvedValueOnce([source] as never);
    host.harness.forkSession.mockResolvedValueOnce({ summary: target, close: vi.fn() });

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
    const source = { id: "session-1", workDir: root, updatedAt: 123 };
    const target = { id: "session-2", workDir: root, updatedAt: 124 };
    const close = vi.fn(async () => undefined);
    host.harness.listSessions.mockResolvedValueOnce([source] as never);
    host.harness.forkSession.mockResolvedValueOnce({ summary: target, close });
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
    expect(close).toHaveBeenCalledOnce();
    expect(host.harness.deleteSession).toHaveBeenCalledWith("session-2");
    expect(deleteBaseline).toHaveBeenCalledWith("session-2");
  });

  it("keeps conversation history available when its baseline snapshot disappears", async () => {
    const session = createResumedSession("session-1", root);
    host.harness.resumeSession.mockResolvedValueOnce(session as never);
    host.showWarningMessage.mockResolvedValueOnce("Show Logs");
    const sourcePath = join(root, "app.ts");
    await writeFile(sourcePath, "original\n", "utf-8");
    await bridge.baselineManager.capture(session.summary, sourcePath);
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
    host.harness.listSessions.mockResolvedValueOnce([] as never);

    const result = await bridge.handle({ id: "rpc-1", method: Methods.GetRegisteredWorkDirs }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: [root] });
  });

  it("keeps the selected working directory visible without session history", async () => {
    const sub = join(root, "packages", "demo");
    await mkdir(sub, { recursive: true });
    host.harness.listSessions.mockResolvedValue([] as never);

    await bridge.handle({ id: "rpc-1", method: Methods.SetWorkDir, params: { workDir: sub } }, "view-1");
    const result = await bridge.handle({ id: "rpc-2", method: Methods.GetRegisteredWorkDirs }, "view-1");

    expect(result).toEqual({ id: "rpc-2", result: [root, sub].toSorted() });
  });

  it("merges session-history directories and hides directories outside the workspace", async () => {
    const inside = join(root, "nested");
    host.harness.listSessions.mockResolvedValueOnce([
      { id: "s-1", workDir: inside },
      { id: "s-2", workDir: "/private/outside" },
      { id: "s-3", workDir: root },
    ] as never);

    const result = await bridge.handle({ id: "rpc-1", method: Methods.GetRegisteredWorkDirs }, "view-1");

    expect(result).toEqual({ id: "rpc-1", result: [inside, root].toSorted() });
    expect(JSON.stringify(result)).not.toContain("/private/outside");
  });
});

describe("Webview config saves (thinking effort persistence parity with the TUI)", () => {
  const effortModel = {
    provider: "managed:kimi-code",
    model: "reasoning",
    supportEfforts: ["low", "high", "max"],
    defaultEffort: "high",
  };

  function mockConfig(thinking?: { enabled: boolean; effort?: string }) {
    host.harness.getConfig.mockResolvedValue({
      defaultModel: "kimi/reasoning",
      thinking,
      models: { "kimi/reasoning": effortModel },
    } as never);
  }

  it("persists a non-top effort as the global default", async () => {
    mockConfig();

    const result = await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "high" } },
      "view-1",
    );

    expect(result).toEqual({ id: "rpc-1", result: { ok: true } });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: "kimi/reasoning",
      thinking: { enabled: true, effort: "high" },
    });
  });

  it("keeps a pick above the model's delivered default session-only", async () => {
    mockConfig();

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "max" } },
      "view-1",
    );

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: "kimi/reasoning",
      thinking: { enabled: true },
    });
  });

  it("persists the top tier when the model's delivered default is the top tier", async () => {
    host.harness.getConfig.mockResolvedValue({
      defaultModel: "kimi/reasoning",
      models: { "kimi/reasoning": { ...effortModel, defaultEffort: "max" } },
    } as never);

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "max" } },
      "view-1",
    );

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: "kimi/reasoning",
      thinking: { enabled: true, effort: "max" },
    });
  });

  it("keeps an xhigh pick session-only when the default comes from the Anthropic profile inference", async () => {
    host.harness.getConfig.mockResolvedValue({
      defaultModel: "custom/claude",
      models: { "custom/claude": { provider: "custom", model: "claude-opus-4-7" } },
    } as never);

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "custom/claude", thinking: true, effort: "xhigh" } },
      "view-1",
    );

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: "custom/claude",
      thinking: { enabled: true },
    });
  });

  it("persists the concrete effort when the model's levels are unknown", async () => {
    host.harness.getConfig.mockResolvedValue({ defaultModel: "other/model", models: {} });

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "custom/model", thinking: true, effort: "max" } },
      "view-1",
    );

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: "custom/model",
      thinking: { enabled: true, effort: "max" },
    });
  });

  it("leaves the stored effort alone when the pick re-confirms the active effort", async () => {
    mockConfig({ enabled: false, effort: "low" });

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "high", effortChanged: false } },
      "view-1",
    );

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: "kimi/reasoning",
      thinking: { enabled: true },
    });
  });

  it("skips the config write entirely when nothing changed", async () => {
    mockConfig({ enabled: true, effort: "high" });

    await bridge.handle(
      { id: "rpc-1", method: Methods.SaveConfig, params: { model: "kimi/reasoning", thinking: true, effort: "high" } },
      "view-1",
    );

    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });
});

describe("Enterprise workspace RPC and membership revocation", () => {
  it("keeps shared BUSINESS_MEMBERSHIP_REVOKED_MESSAGE identical to @moonshot-ai/kimi-code-oauth", () => {
    expect(BUSINESS_MEMBERSHIP_REVOKED_MESSAGE).toBe(OAUTH_REVOKED_MESSAGE);
  });

  it("validates switchWorkspace target payloads at the RPC boundary", async () => {
    const missingBusinessId = await bridge.handle(
      {
        id: "rpc-ws-bad-1",
        method: Methods.SwitchWorkspace,
        params: { target: { kind: "business", businessId: "  " } },
      },
      "view-1",
    );
    const extraPersonalKey = await bridge.handle(
      {
        id: "rpc-ws-bad-2",
        method: Methods.SwitchWorkspace,
        params: { target: { kind: "personal", businessId: "biz_1" } },
      },
      "view-1",
    );

    expect(missingBusinessId).toEqual({
      id: "rpc-ws-bad-1",
      error: "Invalid bridge params for method: switchWorkspace",
    });
    expect(extraPersonalKey).toEqual({
      id: "rpc-ws-bad-2",
      error: "Invalid bridge params for method: switchWorkspace",
    });
    expect(host.harness.auth.switchWorkspace).not.toHaveBeenCalled();
  });

  it("switches workspace, tracks identity_switch, and broadcasts ModelCatalogChanged", async () => {
    host.harness.auth.switchWorkspace.mockResolvedValueOnce({
      providerName: "managed:kimi-code",
      ok: true,
      target: { kind: "business", businessId: "biz_acme" },
      profile: {
        userId: "u_1",
        nickname: "Alex Chen",
        userLevelName: "Premium",
        workspaceName: "Acme AI",
        hasBusinessWorkspace: true,
        activeWorkspaceName: "Acme AI",
        workspaces: [
          {
            kind: "personal",
            key: "personal",
            name: "Alex Chen",
            current: false,
            disabled: false,
            switchable: true,
            roles: ["ROLE_OWNER"],
          },
          {
            kind: "business",
            key: "business:biz_acme",
            businessId: "biz_acme",
            name: "Acme AI",
            status: "STATUS_ACTIVE",
            current: true,
            disabled: false,
            switchable: true,
            roles: ["ROLE_MEMBER"],
          },
        ],
      },
    });

    const response = await bridge.handle(
      {
        id: "rpc-switch-1",
        method: Methods.SwitchWorkspace,
        params: { target: { kind: "business", businessId: "biz_acme" }, fromType: "personal" },
      },
      "view-1",
    );

    expect(response).toMatchObject({
      id: "rpc-switch-1",
      result: {
        kind: "ok",
        target: { kind: "business", businessId: "biz_acme" },
        profile: {
          nickname: "Alex Chen",
          userLevelName: "Premium",
          hasBusinessWorkspace: true,
          activeWorkspaceName: "Acme AI",
        },
      },
    });
    expect(host.track).toHaveBeenCalledWith("identity_switch", {
      from_type: "personal",
      to_type: "enterprise",
      enterprise_id: "biz_acme",
    });
    expect(broadcast).toHaveBeenCalledWith(Events.ModelCatalogChanged, {});
  });

  it("signs out once and broadcasts BusinessMembershipRevoked when getAccountProfile reports REASON_BUSINESS_MEMBER_REMOVED", async () => {
    host.harness.auth.getAccountProfile.mockResolvedValueOnce({
      kind: "error",
      status: 401,
      errorCode: "REASON_BUSINESS_MEMBER_REMOVED",
      message: "Removed from workspace",
    });

    const response = await bridge.handle(
      { id: "rpc-profile-revoked", method: Methods.GetAccountProfile },
      "view-1",
    );

    expect(response).toEqual({
      id: "rpc-profile-revoked",
      result: {
        kind: "error",
        message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
        errorCode: "REASON_BUSINESS_MEMBER_REMOVED",
        revoked: true,
      },
    });
    expect(host.harness.auth.logout).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(Events.BusinessMembershipRevoked, {
      message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });
  });

  it("does not revoke managed login when a custom API-key model reports a business membership error code", async () => {
    host.harness.getConfig.mockResolvedValue({
      defaultModel: "custom/openai",
      models: {
        "custom/openai": { provider: "custom-openai", model: "gpt-4o" },
      },
    });

    await bridge.runtime.handleModelBusinessMembershipRevoked("custom/openai");

    expect(host.harness.auth.logout).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(
      Events.BusinessMembershipRevoked,
      expect.anything(),
    );
  });

  it("completes revocation cleanup and broadcasts BusinessMembershipRevoked even when the token was already tombstoned", async () => {
    host.harness.auth.status.mockResolvedValue({
      providers: [{ providerName: "managed:kimi-code", hasToken: false }],
    });
    host.harness.getConfig.mockResolvedValue({
      defaultModel: "kimi-code/kimi-k2",
      providers: { "managed:kimi-code": { type: "kimi", apiKey: "" } },
      models: {
        "kimi-code/kimi-k2": { provider: "managed:kimi-code", model: "kimi-k2" },
      },
    });

    await bridge.runtime.handleModelBusinessMembershipRevoked("kimi-code/kimi-k2");

    expect(host.harness.auth.logout).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(Events.ModelCatalogChanged, {});
    expect(broadcast).toHaveBeenCalledWith(Events.BusinessMembershipRevoked, {
      message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });
  });

  it("defers model resynchronization for a busy session during workspace switch until its active turn settles", async () => {
    let currentModel = "enterprise-only";
    const setModel = vi.fn(async (next: string) => {
      currentModel = next;
    });
    const setThinking = vi.fn(async () => undefined);
    const busySession = {
      ...createResumedSession("ses-busy", "/workspace/project"),
      getStatus: vi.fn(async () => ({ model: currentModel, thinkingEffort: "off", permission: "manual" })),
      setModel,
      setThinking,
    };
    const runtime = await bridge.runtime.attachResumedSession("view-busy", busySession as never);
    const actionId = runtime.beginHostAction("streaming prompt");

    host.harness.getConfig.mockResolvedValue({
      defaultModel: "kimi-code/kimi-for-coding",
      thinking: { enabled: true, effort: "high" },
      models: {
        "kimi-code/kimi-for-coding": {
          provider: "managed:kimi-code",
          model: "kimi-for-coding",
        },
      },
    });

    await bridge.runtime.syncActiveSessionsModel();
    expect(setModel).not.toHaveBeenCalled();

    runtime.completeHostAction("finished", actionId);
    await vi.waitFor(() => {
      expect(setModel).toHaveBeenCalledWith("kimi-code/kimi-for-coding");
    });
    expect(setThinking).toHaveBeenCalledWith("high");
    expect(broadcast).toHaveBeenCalledWith(
      Events.StreamEvent,
      expect.objectContaining({
        type: "StatusUpdate",
        payload: expect.objectContaining({ model: "kimi-code/kimi-for-coding" }),
      }),
      "view-busy",
    );
  });

  it("discards a stale getAccountProfile revocation response after the auth generation advances", async () => {
    let resolveStaleProfile!: (value: unknown) => void;
    host.harness.auth.getAccountProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStaleProfile = resolve;
        }),
    );
    host.harness.auth.switchWorkspace.mockResolvedValueOnce({
      providerName: "managed:kimi-code",
      ok: true,
      target: { kind: "personal" },
    });

    const staleProfilePromise = bridge.handle(
      { id: "rpc-stale-profile", method: Methods.GetAccountProfile },
      "view-1",
    );

    await bridge.handle(
      {
        id: "rpc-switch-personal",
        method: Methods.SwitchWorkspace,
        params: { target: { kind: "personal" } },
      },
      "view-1",
    );

    resolveStaleProfile({
      kind: "error",
      status: 401,
      errorCode: "REASON_BUSINESS_MEMBER_REMOVED",
      message: "Removed from old business workspace",
    });

    const staleResponse = await staleProfilePromise;
    expect(staleResponse).toEqual({
      id: "rpc-stale-profile",
      result: {
        kind: "error",
        message: "Removed from old business workspace",
        errorCode: "REASON_BUSINESS_MEMBER_REMOVED",
      },
    });
    expect(host.harness.auth.logout).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(
      Events.BusinessMembershipRevoked,
      expect.anything(),
    );
  });

  it("converts HTTPS account avatars into CSP-safe data URIs and omits unsafe avatar URLs", async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn(async () =>
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      host.harness.auth.getAccountProfile.mockResolvedValueOnce({
        kind: "ok",
        profile: {
          userId: "u_avatar",
          nickname: "Alex Chen",
          avatar: "https://example.com/avatar-safe.png",
          userLevelName: "Pro",
          hasBusinessWorkspace: true,
          activeWorkspaceName: "Alex Chen",
          workspaces: [
            {
              kind: "personal",
              key: "personal",
              name: "Alex Chen",
              current: true,
              disabled: false,
              switchable: true,
              roles: ["ROLE_OWNER"],
            },
          ],
        },
      });

      const okRes = await bridge.handle(
        { id: "rpc-avatar-https", method: Methods.GetAccountProfile },
        "view-1",
      );
      expect(okRes).toMatchObject({
        id: "rpc-avatar-https",
        result: {
          kind: "ok",
          profile: {
            avatar: `data:image/png;base64,${pngBytes.toString("base64")}`,
          },
        },
      });

      host.harness.auth.getAccountProfile.mockResolvedValueOnce({
        kind: "ok",
        profile: {
          userId: "u_http",
          nickname: "Alex Chen",
          avatar: "http://example.com/insecure.png",
          userLevelName: "Pro",
          hasBusinessWorkspace: false,
          activeWorkspaceName: "Alex Chen",
          workspaces: [],
        },
      });

      const httpRes = await bridge.handle(
        { id: "rpc-avatar-http", method: Methods.GetAccountProfile },
        "view-1",
      );
      expect(httpRes).toMatchObject({
        id: "rpc-avatar-http",
        result: {
          kind: "ok",
          profile: { nickname: "Alex Chen" },
        },
      });
      expect(
        (httpRes as { result: { profile: { avatar?: string } } }).result.profile.avatar,
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks switchWorkspace while a managed session is busy and waits for in-flight auth mutations before streamChat", async () => {
    const busySession = {
      ...createResumedSession("ses-managed-busy", root),
      getStatus: vi.fn(async () => ({
        model: "kimi-code/kimi-for-coding",
        thinkingEffort: "off",
        permission: "manual",
      })),
    };
    host.harness.getConfig.mockResolvedValue({
      defaultModel: "kimi-code/kimi-for-coding",
      models: {
        "kimi-code/kimi-for-coding": {
          provider: "managed:kimi-code",
          model: "kimi-for-coding",
        },
      },
    });
    const runtime = await bridge.runtime.attachResumedSession("view-1", busySession as never);
    const actionId = runtime.beginHostAction("streaming prompt");

    const rejected = await bridge.handle(
      {
        id: "rpc-switch-busy",
        method: Methods.SwitchWorkspace,
        params: { target: { kind: "business", businessId: "biz_acme" } },
      },
      "view-1",
    );
    expect(rejected).toEqual({
      id: "rpc-switch-busy",
      result: {
        kind: "error",
        message: "Finish or stop the active response before switching workspaces.",
      },
    });
    expect(host.harness.auth.switchWorkspace).not.toHaveBeenCalled();

    runtime.completeHostAction("finished", actionId);

    let resolveSwitch!: () => void;
    let switchSettled = false;
    const gatedMutation = bridge.runtime.enqueueAuthMutation(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = () => {
            switchSettled = true;
            resolve();
          };
        }),
    );

    const openSpy = vi.spyOn(bridge.runtime, "openSession").mockImplementation(async () => {
      expect(switchSettled).toBe(true);
      throw new Error("stop-after-gate-check");
    });

    const chatPromise = bridge.handle(
      {
        id: "rpc-chat-after-switch",
        method: Methods.StreamChat,
        params: { content: "hello", model: "kimi-code/kimi-for-coding" },
      },
      "view-1",
    );

    await Promise.resolve();
    expect(openSpy).not.toHaveBeenCalled();

    resolveSwitch();
    await gatedMutation;
    await chatPromise;
    expect(openSpy).toHaveBeenCalledOnce();
  });
});

function createResumedSession(id: string, workDir: string) {
  const close = vi.fn(async () => undefined);
  const summary = {
    id,
    workDir,
    sessionDir: join("/private/kimi/sessions", id),
    createdAt: 1,
    updatedAt: 2,
    metadata: { vscode_legacy_approval: { yolo: false, afk: false } },
  };
  return {
    id,
    workDir,
    summary,
    close,
    getResumeState: () => ({
      sessionMetadata: { agents: {} },
      agents: {
        main: {
          type: "main",
          config: {
            cwd: workDir,
            modelAlias: "test-model",
            modelCapabilities: {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: 128_000,
            },
            thinkingEffort: "off",
            systemPrompt: "",
          },
          context: { history: [], tokenCount: 0 },
          replay: [],
          permission: { mode: "manual", rules: [] },
          plan: null,
          usage: {},
          tools: [],
          background: [],
        },
      },
    }),
    getStatus: async () => ({ permission: "manual" }),
    setPermission: async () => undefined,
    updateMetadata: async () => undefined,
    setApprovalHandler: () => undefined,
    setQuestionHandler: () => undefined,
    onEvent: () => () => undefined,
  };
}
