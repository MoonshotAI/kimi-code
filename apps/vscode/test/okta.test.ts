/**
 * Scenario: Okta SSO login plumbing runs inside the VS Code extension host.
 * Responsibilities: parse okta.json safely, drive PKCE helpers, run the
 * loopback callback server, map gateway model lists into config sections,
 * persist sessions through SecretStorage + the engine injector, and expose
 * the four bridge methods end to end.
 * Wiring: the real okta module, shared bridge protocol, and handler registry;
 * VS Code, fetch, and the harness are fakes.
 * Run: pnpm --filter kimi-code exec vitest run test/okta.test.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: {
    openExternal: vi.fn(async () => true),
    asExternalUri: vi.fn(async (uri: { toString(): string }) => uri),
  },
  authentication: {
    registerAuthenticationProvider: vi.fn(() => ({ dispose: () => {} })),
    getSession: vi.fn(),
  },
  EventEmitter: class {
    readonly event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  Uri: { parse: (value: string) => ({ toString: () => value, scheme: "http" }) },
  Disposable: class {
    dispose = vi.fn();
  },
  window: { registerUriHandler: vi.fn(() => ({ dispose: () => {} })) },
}));

import { createHash } from "node:crypto";

import { Events, Methods, validateRpcMessage } from "../shared/bridge";
import { handlers } from "../src/handlers";
import { createPkceVerifier, createPkceChallenge, randomState } from "../src/okta/pkce";
import { clearGatewayConfigCache, gatewayConfigPath, loadGatewayConfig, type GatewayConfig } from "../src/okta/gateway-config";
import { clearOktaConfigCache, loadOktaConfig, oktaConfigPath } from "../src/okta/okta-config";
import { startLoopbackServer } from "../src/okta/loopback";
import { applyOktaProviderConfig, fetchOktaModels, type OktaModelEntry } from "../src/okta/models";
import { OktaAuthenticationProvider } from "../src/okta/auth-provider";
import { OktaTokenStore, needsRefresh, type OktaEngineInjector } from "../src/okta/token-store";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "kimi-okta-test-"));
  clearOktaConfigCache();
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  clearOktaConfigCache();
  clearGatewayConfigCache();
});

describe("okta config", () => {
  it("returns undefined when okta.json is missing", () => {
    expect(loadOktaConfig(homeDir)).toBeUndefined();
  });

  it("applies defaults to a minimal valid file", () => {
    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com/", clientId: "cid" }),
    );
    const config = loadOktaConfig(homeDir);
    expect(config).toBeDefined();
    expect(config?.issuer).toBe("https://example.okta.com");
    expect(config?.scopes).toBe("openid profile email offline_access");
    expect(config?.callbackPorts).toEqual([35173, 35174, 35175]);
    expect(config?.authMode).toBe("okta");
    expect(config?.redirectUri).toBeUndefined();
  });

  it("reads a pre-registered vscode:// deep-link redirectUri", () => {
    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com", clientId: "cid", redirectUri: "vscode://moonshot-ai.kimi-code/callback" }),
    );
    expect(loadOktaConfig(homeDir)?.redirectUri).toBe("vscode://moonshot-ai.kimi-code/callback");
  });

  it("honors an explicit authMode opt-out and rejects invalid values", () => {
    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com", clientId: "cid", authMode: "kimi" }),
    );
    expect(loadOktaConfig(homeDir)?.authMode).toBe("kimi");
    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com", clientId: "cid", authMode: "sso" }),
    );
    expect(() => loadOktaConfig(homeDir)).toThrow(/"authMode" must be "okta" or "kimi"/);
  });

  it("rejects a non-https issuer naming the field", () => {
    writeFileSync(oktaConfigPath(homeDir), JSON.stringify({ issuer: "http://example.okta.com", clientId: "cid" }));
    expect(() => loadOktaConfig(homeDir)).toThrow(/"issuer" must use https/);
  });

  it("memoizes by file stats until the file changes", () => {
    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com", clientId: "cid" }),
    );
    const first = loadOktaConfig(homeDir);
    expect(loadOktaConfig(homeDir)).toBe(first);
  });
});

describe("gateway config", () => {
  it("returns undefined when gateway.json is missing", () => {
    expect(loadGatewayConfig(homeDir)).toBeUndefined();
  });

  it("applies defaults and reads explicit values", () => {
    writeFileSync(gatewayConfigPath(homeDir), JSON.stringify({ modelsBaseUrl: "https://api.example.internal/v1/" }));
    expect(loadGatewayConfig(homeDir)).toEqual({
      modelsBaseUrl: "https://api.example.internal/v1",
      modelsPath: "/models",
      providerName: "okta",
      defaultContextLength: 128000,
      protocolAliases: {},
    });
    writeFileSync(
      gatewayConfigPath(homeDir),
      JSON.stringify({ modelsBaseUrl: "http://127.0.0.1:4599", modelsPath: "/v1/models", providerName: "acme", defaultContextLength: 200000 }),
    );
    expect(loadGatewayConfig(homeDir)?.providerName).toBe("acme");
    expect(loadGatewayConfig(homeDir)?.defaultContextLength).toBe(200000);
    writeFileSync(
      gatewayConfigPath(homeDir),
      JSON.stringify({ modelsBaseUrl: "https://api.example.internal", protocolAliases: { openai: "openai_responses" } }),
    );
    expect(loadGatewayConfig(homeDir)?.protocolAliases).toEqual({ openai: "openai_responses" });
  });

  it("rejects non-object or non-string protocolAliases", () => {
    writeFileSync(gatewayConfigPath(homeDir), JSON.stringify({ modelsBaseUrl: "https://api.example.internal", protocolAliases: ["openai"] }));
    expect(() => loadGatewayConfig(homeDir)).toThrow(/"protocolAliases" must be an object/);
    writeFileSync(gatewayConfigPath(homeDir), JSON.stringify({ modelsBaseUrl: "https://api.example.internal", protocolAliases: { openai: 5 } }));
    expect(() => loadGatewayConfig(homeDir)).toThrow(/"protocolAliases.openai" must be a non-empty protocol name/);
  });

  it("rejects a non-URL modelsBaseUrl naming the field", () => {
    writeFileSync(gatewayConfigPath(homeDir), JSON.stringify({ modelsBaseUrl: "not-a-url" }));
    expect(() => loadGatewayConfig(homeDir)).toThrow(/"modelsBaseUrl" must be a URL/);
  });
});

describe("pkce", () => {
  it("builds verifiers from the unreserved alphabet", () => {
    const verifier = createPkceVerifier();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkceChallenge();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("mints unique state values", () => {
    expect(randomState()).not.toBe(randomState());
  });
});

describe("loopback server", () => {
  let blocker: Server | undefined;

  afterEach(() => {
    blocker?.close();
    blocker = undefined;
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => {
          resolve(port);
        });
      });
      probe.once("error", reject);
    });
  }

  it("resolves the code after a state-matching callback", async () => {
    const port = await freePort();
    const server = await startLoopbackServer({ ports: [port], redirectPath: "/callback", state: "s1" });
    try {
      const response = await fetch(`${server.redirectUri}?code=abc&state=s1`);
      expect(response.status).toBe(200);
      expect(await server.callback).toEqual({ code: "abc" });
    } finally {
      server.dispose();
    }
  });

  it("ignores a state-mismatched callback and settles on the real one", async () => {
    const port = await freePort();
    const server = await startLoopbackServer({ ports: [port], redirectPath: "/callback", state: "s1" });
    try {
      const bad = await fetch(`${server.redirectUri}?code=evil&state=other`);
      expect(bad.status).toBe(400);
      const good = await fetch(`${server.redirectUri}?code=ok&state=s1`);
      expect(good.status).toBe(200);
      expect(await server.callback).toEqual({ code: "ok" });
    } finally {
      server.dispose();
    }
  });

  it("short-circuits IdP error redirects", async () => {
    const port = await freePort();
    const server = await startLoopbackServer({ ports: [port], redirectPath: "/callback", state: "s1" });
    try {
      await fetch(`${server.redirectUri}?error=access_denied`);
      expect(await server.callback).toEqual({ error: "Okta authorization failed: access_denied" });
    } finally {
      server.dispose();
    }
  });

  it("moves to the next port when the first is occupied", async () => {
    const first = await freePort();
    blocker = createServer();
    await new Promise<void>((resolve) => blocker!.listen(first, "127.0.0.1", resolve));
    const second = await freePort();
    const server = await startLoopbackServer({ ports: [first, second], redirectPath: "/callback", state: "s1" });
    try {
      expect(server.port).toBe(second);
    } finally {
      server.dispose();
    }
  });
});

describe("models", () => {
  const gateway: GatewayConfig = {
    modelsBaseUrl: "https://api.example.internal",
    modelsPath: "/models",
    providerName: "okta",
    defaultContextLength: 128000,
    protocolAliases: {},
  };

  // Raw catalog entries exactly as the gateway returns them.
  const openaiRaw = {
    model: "gpt-5.4",
    name: "GPT 5.4",
    provider: "openai",
    apiBase: "https://one.example.internal/v1",
    contextLength: "200000",
  };
  const anthropicRaw = {
    model: "claude-x",
    name: "Claude X",
    provider: "anthropic",
    apiBase: "https://two.example.internal/v1",
    contextLength: 128000,
  };
  // The same entries after fetchOktaModels parses them.
  const openaiModel: OktaModelEntry = {
    model: "gpt-5.4",
    displayName: "GPT 5.4",
    protocol: "openai",
    apiBase: "https://one.example.internal/v1",
    contextLength: 200000,
  };
  const anthropicModel: OktaModelEntry = {
    model: "claude-x",
    displayName: "Claude X",
    protocol: "anthropic",
    apiBase: "https://two.example.internal/v1",
    contextLength: 128000,
  };

  it("parses the gateway catalog shape (model/name/provider/apiBase/contextLength)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ data: [openaiRaw, anthropicRaw, { ...openaiRaw }] }), { status: 200 }),
    ));
    const entries = await fetchOktaModels(gateway, "tok");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      model: "gpt-5.4",
      displayName: "GPT 5.4",
      protocol: "openai",
      apiBase: "https://one.example.internal/v1",
      contextLength: 200000,
    });
  });

  it("applies gateway protocolAliases (labels naming a vendor, served over Responses)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ data: [openaiRaw] }), { status: 200 }),
    ));
    const aliased = { ...gateway, protocolAliases: { openai: "openai_responses" } };
    const entries = await fetchOktaModels(aliased, "tok");
    expect(entries[0]?.protocol).toBe("openai_responses");
    const sections = applyOktaProviderConfig({} as never, { gateway: aliased, models: entries });
    expect(sections.providers["okta-openai_responses-one.example.internal"]?.type).toBe("openai_responses");
  });

  it("rejects a protocolAliases value that is not a supported protocol", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ data: [openaiRaw] }), { status: 200 }),
    ));
    const bad = { ...gateway, protocolAliases: { openai: "grpc" } };
    await expect(fetchOktaModels(bad, "tok")).rejects.toThrow(/protocolAliases maps "openai" to "grpc"/);
  });

  it("maps labels only through gateway protocolAliases — nothing is guessed in code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown) =>
      new Response(
        JSON.stringify({
          data: [
            openaiRaw,
            { ...openaiRaw, model: "deepseek-v4", name: "DeepSeek V4", provider: "openrouter" },
          ],
        }),
        { status: 200 },
      ),
    ));
    // Unmapped vendor labels fail loudly instead of silently misrouting.
    await expect(fetchOktaModels(gateway, "tok")).rejects.toThrow(/unsupported protocol "openrouter"/);
    // Both labels map explicitly to the Responses API and share one group.
    const aliased = { ...gateway, protocolAliases: { openai: "openai_responses", openrouter: "openai_responses" } };
    const entries = await fetchOktaModels(aliased, "tok");
    expect(entries.every((entry) => entry.protocol === "openai_responses")).toBe(true);
    const sections = applyOktaProviderConfig({} as never, { gateway: aliased, models: entries });
    expect(sections.providers["okta-openai_responses-one.example.internal"]?.type).toBe("openai_responses");
    expect(sections.models["okta-openai_responses-one.example.internal/deepseek-v4"]).toBeDefined();
  });

  it("rejects unknown protocols and missing apiBase with the model named", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ data: [{ ...openaiRaw, provider: "openai-compat" }] }), { status: 200 }),
    ));
    await expect(fetchOktaModels(gateway, "tok")).rejects.toThrow(/unsupported protocol "openai-compat"/);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ data: [{ ...openaiRaw, apiBase: undefined }] }), { status: 200 }),
    ));
    await expect(fetchOktaModels(gateway, "tok")).rejects.toThrow(/missing "apiBase"/);
  });

  it("groups models by protocol and apiBase into provider sections", () => {
    const sections = applyOktaProviderConfig({} as never, { gateway, models: [openaiModel, anthropicModel] });
    expect(Object.keys(sections.providers).sort()).toEqual(["okta-anthropic-two.example.internal", "okta-openai-one.example.internal"]);
    expect(sections.providers["okta-openai-one.example.internal"]).toEqual({
      type: "openai",
      baseUrl: "https://one.example.internal/v1",
      apiKey: "",
    });
    expect(sections.models["okta-openai-one.example.internal/gpt-5.4"]).toMatchObject({
      provider: "okta-openai-one.example.internal",
      model: "gpt-5.4",
      displayName: "GPT 5.4",
      maxContextSize: 200000,
    });
    expect(sections.models["okta-anthropic-two.example.internal/claude-x"]?.maxContextSize).toBe(128000);
    expect(sections.providerNames).toContain("okta-openai-one.example.internal");
    expect(sections.defaultModel).toBe("okta-openai-one.example.internal/gpt-5.4");
  });

  it("falls back to defaultContextLength when the entry omits contextLength", () => {
    const sections = applyOktaProviderConfig({} as never, {
      gateway,
      models: [{ ...openaiModel, contextLength: undefined }],
    });
    expect(sections.models["okta-openai-one.example.internal/gpt-5.4"]?.maxContextSize).toBe(128000);
  });

  it("heals stale groups: removes our prefixed sections and aliases absent from the catalog", () => {
    const config = {
      providers: {
        "okta-openai-one.example.internal": { type: "openai", baseUrl: "https://one.example.internal/v1", apiKey: "" },
        "okta-openai-gone.example.internal": { type: "openai", baseUrl: "https://gone.example.internal/v1", apiKey: "" },
        other: { type: "openai", baseUrl: "https://other.example", apiKey: "k" },
      },
      models: {
        "okta-openai-gone.example.internal/old": { provider: "okta-openai-gone.example.internal", model: "old", maxContextSize: 1 },
        "okta-openai-one.example.internal/gpt-5.4": { provider: "okta-openai-one.example.internal", model: "gpt-5.4", maxContextSize: 1, overrides: { displayName: "Custom" } },
        "other/keep": { provider: "other", model: "keep", maxContextSize: 1 },
      },
      defaultModel: "other/keep",
    } as never;
    const sections = applyOktaProviderConfig(config, { gateway, models: [openaiModel] });
    expect(sections.providers["okta-openai-gone.example.internal"]).toBeUndefined();
    expect(sections.providers["okta-openai-one.example.internal"]).toBeDefined();
    expect(sections.providers["other"]).toBeDefined();
    expect(sections.models["okta-openai-gone.example.internal/old"]).toBeUndefined();
    expect(sections.models["okta-openai-one.example.internal/gpt-5.4"]?.["overrides"]).toEqual({ displayName: "Custom" });
    expect(sections.models["other/keep"]).toBeDefined();
    expect(sections.defaultModel).toBe("other/keep");
  });

  it("keeps names stable across re-provisioning (same catalog, same names)", () => {
    const first = applyOktaProviderConfig({} as never, { gateway, models: [openaiModel, anthropicModel] });
    const config = { providers: first.providers, models: first.models, defaultModel: first.defaultModel } as never;
    const second = applyOktaProviderConfig(config, { gateway, models: [openaiModel, anthropicModel] });
    expect([...second.providerNames].sort()).toEqual([...first.providerNames].sort());
    expect(second.models["okta-openai-one.example.internal/gpt-5.4"]).toBeDefined();
  });

  it("suffices same-host same-protocol groups differently", () => {
    const otherBase = { ...openaiModel, model: "gpt-5.4-mini", apiBase: "https://one.example.internal/v2" };
    const sections = applyOktaProviderConfig({} as never, { gateway, models: [openaiModel, otherBase] });
    expect([...sections.providerNames].sort()).toEqual([
      "okta-openai-one.example.internal",
      "okta-openai-one.example.internal-2",
    ].sort());
  });

  it("refuses an empty model list", () => {
    expect(() => applyOktaProviderConfig({} as never, { gateway, models: [] })).toThrow(/No models available/);
  });

  it("surfaces gateway failures with the status code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 })));
    await expect(fetchOktaModels(gateway, "tok")).rejects.toThrow(/\(HTTP 503\): nope/);
  });
});

describe("token store", () => {
  function makeStore(): { store: OktaTokenStore; secrets: Map<string, string>; injector: OktaEngineInjector } {
    const secrets = new Map<string, string>();
    const injector: OktaEngineInjector = {
      inject: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const store = new OktaTokenStore({
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => void secrets.set(key, value),
        delete: async (key: string) => void secrets.delete(key),
      } as never,
      logError: () => {},
    });
    store.setEngineInjector(injector);
    return { store, secrets, injector };
  }

  const session = {
    token: { accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 3000, scope: "openid", tokenType: "Bearer", expiresIn: 3600 },
    accountLabel: "user@example.com",
    providerNames: ["okta-openai-one.example.internal", "okta-anthropic-two.example.internal"],
  };

  it("persists to SecretStorage and pushes the access token to the engine", async () => {
    const { store, secrets, injector } = makeStore();
    await store.save(session);
    expect(JSON.parse(secrets.get("kimi-code.okta") ?? "{}")).toEqual(session);
    expect(injector.inject).toHaveBeenCalledWith("at", session.providerNames);
    expect(await store.load()).toEqual(session);
  });

  it("updates provider names post-provision and re-injects", async () => {
    const { store, injector } = makeStore();
    await store.save({ ...session, providerNames: [] });
    expect(injector.inject).toHaveBeenLastCalledWith("at", []);
    await store.updateProviderNames(["okta-openai-one.example.internal"]);
    expect(injector.inject).toHaveBeenLastCalledWith("at", ["okta-openai-one.example.internal"]);
    expect((await store.load())?.providerNames).toEqual(["okta-openai-one.example.internal"]);
  });

  it("clears both tiers on logout", async () => {
    const { store, secrets, injector } = makeStore();
    await store.save(session);
    await store.clear();
    expect(secrets.has("kimi-code.okta")).toBe(false);
    expect(injector.clear).toHaveBeenCalled();
    expect(await store.load()).toBeUndefined();
  });

  it("flags tokens past half their lifetime", () => {
    const now = 500_000;
    const token = { accessToken: "at", refreshToken: "rt", expiresAt: 500_500, scope: "", tokenType: "Bearer", expiresIn: 1000 };
    expect(needsRefresh(token, now)).toBe(true);
    expect(needsRefresh({ ...token, expiresAt: now + 900 }, now)).toBe(false);
  });
});

describe("activation restore", () => {
  it("re-injects a stored session into the engine without okta.json", async () => {
    const freshSession = {
      token: { accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 3000, scope: "openid", tokenType: "Bearer", expiresIn: 3600 },
      accountLabel: "user@example.com",
      providerNames: ["okta-openai-one.example.internal"],
    };
    const secrets = new Map<string, string>([["kimi-code.okta", JSON.stringify(freshSession)]]);
    const injector: OktaEngineInjector = {
      inject: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const store = new OktaTokenStore({
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => void secrets.set(key, value),
        delete: async (key: string) => void secrets.delete(key),
      } as never,
      logError: () => {},
    });
    store.setEngineInjector(injector);
    const provider = new OktaAuthenticationProvider({
      harness: { homeDir } as never,
      tokenStore: store,
      log: () => {},
      logError: () => {},
    });
    // No okta.json in homeDir: the restore must still inject the token.
    await provider.restoreOnActivation();
    expect(injector.inject).toHaveBeenCalledWith("at", ["okta-openai-one.example.internal"]);
  });
});

describe("deep-link callback flow", () => {
  it("completes sign-in via the vscode:// URI handler when redirectUri is set", async () => {
    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({
        issuer: "https://example.okta.com",
        clientId: "cid",
        redirectUri: "vscode://moonshot-ai.kimi-code/callback",
        scopes: "openid",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid", token_type: "Bearer" }),
          { status: 200 },
        ),
      ),
    );
    const secrets = new Map<string, string>();
    const injector: OktaEngineInjector = { inject: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const store = new OktaTokenStore({
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => void secrets.set(key, value),
        delete: async (key: string) => void secrets.delete(key),
      } as never,
      logError: () => {},
    });
    store.setEngineInjector(injector);
    const provider = new OktaAuthenticationProvider({
      harness: { homeDir } as never,
      tokenStore: store,
      log: () => {},
      logError: () => {},
    });
    provider.onLoginUrl = (url) => {
      const authorize = new URL(url);
      expect(authorize.searchParams.get("redirect_uri")).toBe("vscode://moonshot-ai.kimi-code/callback");
      void provider.handleUri({ query: "code=abc&state=" + (authorize.searchParams.get("state") ?? "") } as never);
    };
    const session = await provider.createSession(["openid"]);
    expect(session.accessToken).toBe("at");
    expect((await store.load())?.token.refreshToken).toBe("rt");
    provider.handleUri({ query: "code=late&state=whatever" } as never);
  });
});

describe("bridge protocol surface", () => {
  it("accepts the four okta methods without params", () => {
    for (const method of [Methods.OktaLogin, Methods.OktaLogout, Methods.OktaStatus, Methods.GetAuthMode]) {
      const validation = validateRpcMessage({ id: "1", method });
      expect(validation.ok).toBe(true);
    }
  });

  it("rejects them with params and rejects unknown methods", () => {
    expect(validateRpcMessage({ id: "1", method: Methods.OktaLogin, params: {} }).ok).toBe(false);
    expect(validateRpcMessage({ id: "1", method: "oktaFish" }).ok).toBe(false);
  });

  it("registers the okta handlers and the login-url event", () => {
    for (const method of [Methods.OktaLogin, Methods.OktaLogout, Methods.OktaStatus, Methods.GetAuthMode]) {
      expect(Object.hasOwn(handlers, method)).toBe(true);
    }
    expect(Events.OktaLoginUrl).toBe("oktaLoginUrl");
  });

  it("defaults the auth mode to okta, surfacing arming errors for the page", async () => {
    const getAuthMode = handlers[Methods.GetAuthMode] as (
      params: undefined,
      ctx: { harness: { homeDir: string } },
    ) => Promise<{ mode: string; error: string | null }>;
    const unconfigured = await getAuthMode(undefined, { harness: { homeDir } });
    expect(unconfigured.mode).toBe("okta");
    expect(unconfigured.error).toMatch(/not configured/);

    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com", clientId: "cid", apiBaseUrl: "https://api.example.internal/v1" }),
    );
    const configured = await getAuthMode(undefined, { harness: { homeDir } });
    expect(configured).toEqual({ mode: "okta", error: null });

    writeFileSync(
      oktaConfigPath(homeDir),
      JSON.stringify({ issuer: "https://example.okta.com", clientId: "cid", apiBaseUrl: "https://api.example.internal/v1", authMode: "kimi" }),
    );
    const kimi = await getAuthMode(undefined, { harness: { homeDir } });
    expect(kimi).toEqual({ mode: "kimi", error: null });
  });
});
