import { describe, expect, it, vi } from "vitest";

import type { MigrationPlan } from "@moonshot-ai/migration-legacy";
import { log } from "@moonshot-ai/kimi-code-sdk";

import { KimiTUI, type KimiTUIStartupInput, type TUIState } from "#/tui/kimi-tui";
import {
  handleLoginCommand,
  handleLogoutCommand,
} from "#/tui/commands/auth";
import {
  promptPlatformSelection,
  promptLogoutProviderSelection,
} from "#/tui/commands/prompts";

vi.mock("#/tui/commands/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/tui/commands/prompts")>();
  return { ...actual, promptPlatformSelection: vi.fn(), promptLogoutProviderSelection: vi.fn() };
});
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_LIGHT,
} from "#/tui/utils/terminal-theme";

interface StartupDriver {
  state: TUIState;
  init(): Promise<boolean>;
  handleLoginCommand(): Promise<void>;
  handleLogoutCommand(): Promise<void>;
}

interface ThemeTrackingDriver extends StartupDriver {
  refreshTerminalThemeTracking(): void;
}

interface MigrateExitDriver extends StartupDriver {
  start(): Promise<void>;
  onExit?: (code?: number) => Promise<void>;
  runMigrationScreen(plan: unknown): Promise<unknown>;
  initMainTui(): Promise<boolean>;
  terminalFocusTrackingDispose?: () => void;
}

const MIGRATION_PLAN: MigrationPlan = {
  sourceHome: "/x/.kimi",
  hasConfig: false,
  hasMcp: false,
  hasUserHistory: false,
  oauthCredentials: [],
  workdirs: [],
  detectedPlugins: [],
  detectedMcpOauthServers: [],
  totalSessions: 0,
};

function makeStartupInput(
  cliOptions: Partial<KimiTUIStartupInput["cliOptions"]> = {},
  tuiConfig: Partial<KimiTUIStartupInput["tuiConfig"]> = {},
  resolvedTheme: KimiTUIStartupInput["resolvedTheme"] = "dark",
): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      ...cliOptions,
    },
    tuiConfig: {
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
      ...tuiConfig,
    },
    version: "0.0.0-test",
    workDir: "/tmp/proj-a",
    resolvedTheme,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses-1",
    model: "k2",
    summary: { title: "Session title" },
    getStatus: vi.fn(async () => ({
      model: "k2",
      thinkingLevel: "off",
      permission: "manual",
      planMode: false,
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    listSkills: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function loginRequiredError(): Error & { readonly code: string } {
  return Object.assign(new Error('OAuth provider "managed:kimi-code" requires login.'), {
    code: "auth.login_required",
  });
}

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: "moonshot-v1", maxContextSize: 100 },
      },
    })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFlags: vi.fn(async () => ({})),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
    ...overrides,
  };
}

function makeDriver(harness: ReturnType<typeof makeHarness>, input: KimiTUIStartupInput) {
  const driver = new KimiTUI(harness as never, input) as unknown as StartupDriver;
  vi.spyOn(driver.state.ui, "requestRender").mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, "setProgress").mockImplementation(() => {});
  return driver;
}

type InputListener = Parameters<TUIState["ui"]["addInputListener"]>[0];
const DARK_OSC11_REPORT = "\u001B]11;rgb:2828/2c2c/3434\u0007";
const LIGHT_OSC11_REPORT = "\u001B]11;rgb:fafa/fbfb/fcfc\u0007";

function captureInputListeners(driver: StartupDriver) {
  const listeners: InputListener[] = [];
  const removeInputListener = vi.fn<() => void>();
  const write = vi.spyOn(driver.state.terminal, "write").mockImplementation(() => {});
  const addInputListener = vi
    .spyOn(driver.state.ui, "addInputListener")
    .mockImplementation((listener: InputListener) => {
      listeners.push(listener);
      return removeInputListener;
    });

  return { listeners, removeInputListener, write, addInputListener };
}

describe("KimiTUI startup", () => {
  it("creates a fresh session from startup flags and syncs runtime state", async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: "k2",
        thinkingLevel: "off",
        permission: "yolo",
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 200,
        contextUsage: 0.125,
      })),
    });
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: "/tmp/proj-a",
      permission: "yolo",
      planMode: true,
    });
    expect(session.setApprovalHandler).toHaveBeenCalledOnce();
    expect(session.setQuestionHandler).toHaveBeenCalledOnce();
    expect(harness.setTelemetryContext).toHaveBeenCalledWith({ sessionId: null });
    expect(harness.setTelemetryContext).toHaveBeenLastCalledWith({ sessionId: "ses-1" });
    expect(driver.state.startupState).toBe("ready");
    expect(driver.state.appState).toMatchObject({
      sessionId: "ses-1",
      model: "k2",
      permissionMode: "yolo",
      planMode: true,
      contextTokens: 25,
      maxContextTokens: 200,
      contextUsage: 0.125,
      sessionTitle: "Session title",
    });
  });

  it("resumes the latest session for --continue and marks history for replay", async () => {
    const session = makeSession({ id: "ses-latest" });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: "ses-latest" }, { id: "ses-old" }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: "ses-latest" });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe("ready");
    expect(driver.state.appState.sessionId).toBe("ses-latest");
  });

  it("passes the CLI model override when creating a fresh startup session", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ model: "kimi-code/k2.5" }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: "/tmp/proj-a",
      model: "kimi-code/k2.5",
      permission: undefined,
      planMode: undefined,
    });
  });

  it("applies the CLI model override when resuming a startup session", async () => {
    let model = "k2";
    const session = makeSession({
      setModel: vi.fn(async (nextModel: string) => {
        model = nextModel;
      }),
      getStatus: vi.fn(async () => ({
        model,
        thinkingLevel: "off",
        permission: "manual",
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: "ses-latest" }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ continue: true, model: "kimi-code/k2.5" }),
    );

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setModel).toHaveBeenCalledWith("kimi-code/k2.5");
    expect(driver.state.appState.model).toBe("kimi-code/k2.5");
  });

  it("enters picker startup for bare --session without creating a session", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ session: "" }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe("picker");
  });

  it("tracks terminal theme reports while auto theme is active", () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: "auto" }, "dark"),
    ) as unknown as ThemeTrackingDriver;
    const { listeners, write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    write.mockClear();
    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(driver.state.appState.theme).toBe("auto");
    expect(driver.state.theme.resolvedTheme).toBe("dark");
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(DARK_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe("auto");
    expect(driver.state.theme.resolvedTheme).toBe("dark");
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe("auto");
    expect(driver.state.theme.resolvedTheme).toBe("light");
    expect(driver.state.ui.requestRender).toHaveBeenCalled();
  });

  it("does not track terminal theme reports for explicit themes", () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput()) as unknown as ThemeTrackingDriver;
    const { write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("disables terminal theme reports after leaving auto theme", () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: "auto" }, "dark"),
    ) as unknown as ThemeTrackingDriver;
    const { write, removeInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();
    driver.state.appState.theme = "dark";
    driver.refreshTerminalThemeTracking();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });

  it("starts TUI without a session when fresh startup needs OAuth login", async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe("ready");
    expect((driver as any).startupNotice).toContain("OAuth login expired");
    expect(driver.state.appState).toMatchObject({
      sessionId: "",
      model: "",
      thinking: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
  });

  it("preserves fresh startup yolo and plan intent after OAuth login", async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: "k2",
        thinkingLevel: "off",
        permission: "yolo",
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session);
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: "k2",
        defaultThinking: false,
        models: {
          k2: { model: "moonshot-v1", maxContextSize: 100 },
        },
      })),
      createSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.appState).toMatchObject({
      sessionId: "",
      model: "",
      permissionMode: "yolo",
      planMode: true,
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(1, {
      workDir: "/tmp/proj-a",
      permission: "yolo",
      planMode: true,
    });
    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: "/tmp/proj-a",
      model: "k2",
      thinking: "off",
      permission: "yolo",
      planMode: true,
    });
    expect(driver.state.appState).toMatchObject({
      sessionId: "ses-1",
      model: "k2",
      permissionMode: "yolo",
      planMode: true,
    });
  });

  it("does not force manual permission after OAuth login without --yolo", async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: "k2",
        thinkingLevel: "off",
        permission: "auto",
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session);
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: "k2",
        defaultThinking: false,
        models: {
          k2: { model: "moonshot-v1", maxContextSize: 100 },
        },
      })),
      createSession,
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: "/tmp/proj-a",
      model: "k2",
      thinking: "off",
      permission: undefined,
      planMode: undefined,
    });
    expect(driver.state.appState).toMatchObject({
      permissionMode: "auto",
    });
  });

  it("syncs configured thinking after OAuth login refreshes an active session", async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: "k2",
        defaultThinking: true,
        models: {
          k2: { model: "moonshot-v1", maxContextSize: 100 },
        },
      })),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState.thinking).toBe(false);

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(session.setModel).toHaveBeenCalledWith("k2");
    expect(session.setThinking).toHaveBeenCalledWith("on");
    expect(driver.state.appState).toMatchObject({
      model: "k2",
      thinking: true,
      maxContextTokens: 100,
    });
    expect(harness.track).toHaveBeenCalledWith("login", {
      provider: "managed:kimi-code",
      already_logged_in: false,
    });
  });

  it("tracks login with already_logged_in when a token already exists", async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: "managed:kimi-code", hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(harness.auth.login).toHaveBeenCalledWith(
      "managed:kimi-code",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onDeviceCode: expect.any(Function),
      }),
    );
    expect(harness.track).toHaveBeenCalledWith("login", {
      provider: "managed:kimi-code",
      already_logged_in: true,
    });
  });

  it("logs login failures with session context", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const session = makeSession();
    const loginError = new Error("Failed to list Kimi Code models (HTTP 402).");
    const harness = makeHarness(session, {
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async () => {
          throw loginError;
        }),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    try {
      await expect(driver.init()).resolves.toBe(false);

      vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
      await handleLoginCommand(driver as any);

      expect(harness.auth.login).toHaveBeenCalledWith(
        "managed:kimi-code",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onDeviceCode: expect.any(Function),
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        "login failed",
        expect.objectContaining({
          providerName: "managed:kimi-code",
          alreadyLoggedIn: false,
          sessionId: "ses-1",
          error: expect.objectContaining({
            message: "Failed to list Kimi Code models (HTTP 402).",
          }),
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("tracks logout after managed credentials and session state are cleared", async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: "managed:kimi-code", model: "moonshot-v1", maxContextSize: 100 },
        },
        providers: { "managed:kimi-code": { type: "kimi" } },
      })),
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: "managed:kimi-code", hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue(
      "managed:kimi-code",
    );
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith("managed:kimi-code");
    expect(session.close).toHaveBeenCalledOnce();
    expect(driver.state.appState).toMatchObject({
      sessionId: "",
      model: "",
      sessionTitle: null,
    });
    expect(harness.track).toHaveBeenCalledWith("logout", { provider: "managed:kimi-code" });
  });

  it("keeps the active session when logging out a different provider", async () => {
    const session = makeSession();
    const removeProvider = vi.fn(async () => {});
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: "managed:kimi-code", model: "moonshot-v1", maxContextSize: 100 },
        },
        providers: {
          "managed:kimi-code": { type: "kimi" },
          openai: { type: "openai", baseUrl: "https://api.openai.com/v1" },
        },
      })),
      removeProvider,
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: "managed:kimi-code", hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue("openai");
    await handleLogoutCommand(driver as any);

    expect(removeProvider).toHaveBeenCalledWith("openai");
    expect(harness.auth.logout).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: "ses-1",
      model: "k2",
    });
    expect(harness.track).toHaveBeenCalledWith("logout", { provider: "openai" });
  });

  it("can log out a stale managed entry even after the OAuth token is gone", async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: "managed:kimi-code", model: "moonshot-v1", maxContextSize: 100 },
        },
        providers: { "managed:kimi-code": { type: "kimi" } },
      })),
      auth: {
        // Token gone (e.g. credentials file deleted) but the managed entry
        // is still sitting in config.providers.
        status: vi.fn(async () => ({
          providers: [{ providerName: "managed:kimi-code", hasToken: false }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue(
      "managed:kimi-code",
    );
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith("managed:kimi-code");
  });

  it("starts TUI without replaying when --continue needs OAuth login", async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: "ses-latest" }]),
      resumeSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: "ses-latest" });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe("ready");
    expect(driver.state.appState.sessionId).toBe("");
  });

  it("starts TUI without replaying when an explicit resume needs OAuth login", async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: "ses-target", workDir: "/tmp/proj-a" }]),
      resumeSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: "ses-target" }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.resumeSession).toHaveBeenCalledWith({ id: "ses-target" });
    expect(driver.state.startupState).toBe("ready");
    expect(driver.state.appState.sessionId).toBe("");
  });

  it("disposes terminal focus/theme tracking on the kimi migrate exit", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver;
    // pi-tui start/stop and focus tracking touch the real TTY — stub the I/O.
    vi.spyOn(driver.state.ui, "start").mockImplementation(() => {});
    vi.spyOn(driver.state.ui, "stop").mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, "write").mockImplementation(() => {});
    // The migration screen would await user input; resolve it immediately.
    vi.spyOn(driver, "runMigrationScreen").mockResolvedValue({ decision: "later" });
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    await driver.start();

    // `kimi migrate` exits via process.exit; startEventLoop() installed focus
    // tracking, so the exit path must dispose it — otherwise the terminal
    // keeps emitting focus/OSC sequences after the command finishes.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("disposes terminal tracking when post-migration startup fails", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: false,
    }) as unknown as MigrateExitDriver;
    vi.spyOn(driver.state.ui, "start").mockImplementation(() => {});
    vi.spyOn(driver.state.ui, "stop").mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, "write").mockImplementation(() => {});
    // The migration screen resolves "later"; startup then continues into
    // initMainTui(), which fails (e.g. a session-resume error).
    vi.spyOn(driver, "runMigrationScreen").mockResolvedValue({ decision: "later" });
    vi.spyOn(driver, "initMainTui").mockRejectedValue(new Error("resume boom"));

    await expect(driver.start()).rejects.toThrow("resume boom");

    // The focus tracking installed by startEventLoop() must be torn down
    // before the error propagates — not left active after the process exits.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
  });

  it("keeps non-login startup session errors fatal", async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw new Error("provider config is invalid");
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).rejects.toThrow("provider config is invalid");
  });

  it("does not mount the footer when resuming a missing session fails", async () => {
    // Regression: a stray pre-startEventLoop render used to paint the footer
    // (cwd/git + "context:" statusline) to the terminal before the fatal
    // error, leaving it stranded above the error message. The footer must not
    // be in the layout tree when initMainTui() throws.
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => []),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: "missing-session" }),
    ) as unknown as MigrateExitDriver;

    await expect(driver.initMainTui()).rejects.toThrow(
      'Session "missing-session" not found.',
    );
    expect(uiContainsFooter(driver)).toBe(false);
  });

  it("mounts the footer once startup reaches the main TUI", async () => {
    const session = makeSession({ id: "ses-target" });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: "ses-target", workDir: "/tmp/proj-a" }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: "ses-target" }),
    ) as unknown as MigrateExitDriver;

    // Not mounted until init() succeeds.
    expect(uiContainsFooter(driver)).toBe(false);

    await driver.initMainTui();

    expect(uiContainsFooter(driver)).toBe(true);
  });
});

function uiContainsFooter(driver: StartupDriver): boolean {
  const target: unknown = driver.state.footer;
  const visit = (node: unknown): boolean => {
    if (node === target) return true;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) && children.some(visit);
  };
  return visit(driver.state.ui);
}
