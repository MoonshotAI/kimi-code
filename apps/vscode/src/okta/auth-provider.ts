/**
 * VS Code authentication provider for Okta SSO (authorization code + PKCE,
 * RFC 7636). The webview never talks to Okta: it asks for a session via
 * `vscode.authentication.getSession(OKTA_PROVIDER_ID, ...)`, which lands here.
 *
 * The provider is constructed and registered at extension activation WITHOUT
 * reading okta.json — everything config-dependent (issuer, client id, ports)
 * resolves lazily at call time, so activation never blocks on or fails from
 * configuration. Flow once a session is requested: start a loopback server →
 * map its URI through `asExternalUri` (remote workspaces) → open
 * `${issuer}/v1/authorize` in the system browser → the IdP redirects back to
 * the loopback server with `code` + `state` → exchange the code at
 * `${issuer}/v1/token` → persist via `OktaTokenStore` (SecretStorage +
 * in-memory engine injection) → return the session.
 *
 * `onLoginUrl` is assigned by the bridge handler before each interactive
 * login so the webview can show the authorize URL as a fallback link.
 */
import * as vscode from "vscode";

import type { TokenInfo } from "@moonshot-ai/kimi-code-oauth";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

import { loadOktaConfig, type OktaSsoConfig } from "./okta-config";
import { createPkceChallenge, randomState } from "./pkce";
import { startLoopbackServer, type LoopbackCallbackResult } from "./loopback";
import { OktaTokenStore, needsRefresh, type StoredOktaSession } from "./token-store";

export const OKTA_PROVIDER_ID = "kimi-code-okta";
export const OKTA_PROVIDER_LABEL = "Okta SSO";

export function oktaScopes(config: OktaSsoConfig): string[] {
  return config.scopes.split(/\s+/).filter((scope) => scope.length > 0);
}

/** The refresh token was rejected (expired/revoked): the session is gone. */
export class OktaRefreshExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OktaRefreshExpiredError";
  }
}

interface OktaTokenResponse {
  readonly token: TokenInfo;
  readonly accountLabel: string;
}

export class OktaAuthenticationProvider implements vscode.AuthenticationProvider {
  /** Per-call hook; assigned by the handler to broadcast the authorize URL. */
  onLoginUrl: ((url: string) => void) | undefined;

  private readonly harness: KimiHarness;
  private readonly tokenStore: OktaTokenStore;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, error: unknown) => void;
  private readonly _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private inFlightCreate: Promise<vscode.AuthenticationSession> | undefined;
  /** Pending vscode:// deep-link callback, if a login flow is waiting on one. */
  private pendingCallback: { readonly state: string; readonly resolve: (result: LoopbackCallbackResult) => void } | undefined;

  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(options: {
    readonly harness: KimiHarness;
    readonly tokenStore: OktaTokenStore;
    readonly log: (message: string) => void;
    readonly logError: (message: string, error: unknown) => void;
  }) {
    this.harness = options.harness;
    this.tokenStore = options.tokenStore;
    this.log = options.log;
    this.logError = options.logError;
  }

  async getSessions(
    _scopes?: readonly string[],
  ): Promise<vscode.AuthenticationSession[]> {
    const stored = await this.tokenStore.load();
    if (stored === undefined || stored.token.accessToken.length === 0) return [];
    return [this.toSession(stored)];
  }

  async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    // Single-flight: a second caller (double-click, second panel) joins the
    // browser flow already in progress instead of opening another one.
    this.inFlightCreate ??= this.runCreateSession(scopes).finally(() => {
      this.inFlightCreate = undefined;
    });
    return this.inFlightCreate;
  }

  async removeSession(): Promise<void> {
    await this.tokenStore.clear();
    this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
  }

  /**
   * vscode:// deep-link callback (redirectUri mode): Okta redirects the
   * browser to the registered vscode:// URI and VS Code routes it here.
   * A state mismatch (stale link, another window) is ignored.
   */
  handleUri(uri: vscode.Uri): void {
    const pending = this.pendingCallback;
    if (pending === undefined) return;
    const params = new URLSearchParams(uri.query);
    const error = params.get("error");
    if (error !== null) {
      pending.resolve({ error: `Okta authorization failed: ${error}` });
      this.pendingCallback = undefined;
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (code !== null && state === pending.state) {
      pending.resolve({ code });
      this.pendingCallback = undefined;
    }
  }

  /**
   * Restore the previous login after a window reload — no okta.json needed:
   * the stored session carries everything the restore uses (token + provider
   * name). Re-injects the still-valid access token into the engine's memory
   * config (empty in the fresh engine process), refreshes instead when past
   * half its lifetime (that path DOES need okta.json), and starts the refresh
   * timer when configuration is available.
   */
  async restoreOnActivation(): Promise<void> {
    try {
      const stored = await this.tokenStore.load();
      if (stored === undefined) return;
      const config = this.tryConfig();
      if (config === undefined) {
        // Login happened, but okta.json is gone now: inject what we still
        // have and leave refreshing to the next sign-in.
        await this.tokenStore.injectNow(stored);
        this.log("Okta session restored without okta.json; token refresh is disabled until the next sign-in.");
        return;
      }
      if (stored.token.accessToken.length === 0 || needsRefresh(stored.token)) {
        // refresh() persists via tokenStore.save(), which re-injects.
        await this.refresh();
      } else {
        await this.tokenStore.injectNow(stored);
      }
      this.startRefreshTimer();
      this.log(`Okta session restored (${stored.accountLabel})`);
    } catch (error) {
      if (error instanceof OktaRefreshExpiredError) return;
      this.logError("Okta session restore failed", error);
    }
  }

  startRefreshTimer(): void {
    this.tokenStore.startRefreshTimer(async () => {
      try {
        return await this.refresh();
      } catch (error) {
        if (error instanceof OktaRefreshExpiredError) {
          this.log(`Okta session expired: ${error.message}`);
        } else {
          this.logError("Okta token refresh failed", error);
        }
        return undefined;
      }
    });
  }

  /**
   * Refresh the stored token via the refresh_token grant. Returns the new
   * stored session (already persisted). Throws `OktaRefreshExpiredError`
   * after clearing storage when the refresh token is rejected.
   */
  async refresh(): Promise<StoredOktaSession> {
    const config = this.requireConfig();
    const stored = await this.tokenStore.load();
    if (stored === undefined || stored.token.refreshToken.length === 0) {
      await this.removeSession();
      throw new OktaRefreshExpiredError("No Okta refresh token available; sign in again.");
    }
    let response: OktaTokenResponse;
    try {
      response = await this.postToken(config, {
        grant_type: "refresh_token",
        refresh_token: stored.token.refreshToken,
        client_id: config.clientId,
      });
    } catch (error) {
      if (error instanceof OktaRefreshExpiredError) {
        await this.removeSession();
      }
      throw error;
    }
    const refreshed: StoredOktaSession = {
      token: response.token,
      // Refresh responses carry no id_token; keep the label from login.
      accountLabel: stored.accountLabel,
      providerNames: stored.providerNames,
    };
    await this.tokenStore.save(refreshed);
    this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
    return refreshed;
  }

  dispose(): void {
    this._onDidChangeSessions.dispose();
  }

  /** Lazy configuration: okta.json is only read when a flow needs it. */
  private requireConfig(): OktaSsoConfig {
    const config = this.tryConfig();
    if (config === undefined) {
      throw new Error("Okta SSO is not configured. Create ~/.kimi-code/okta.json (issuer, clientId) and gateway.json (apiBaseUrl) to enable it.");
    }
    return config;
  }

  private tryConfig(): OktaSsoConfig | undefined {
    try {
      return loadOktaConfig(this.harness.homeDir);
    } catch (error) {
      this.logError("Okta SSO configuration is invalid", error);
      return undefined;
    }
  }

  private async runCreateSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const config = this.requireConfig();
    const state = randomState();
    const { verifier, challenge } = createPkceChallenge();
    // Two callback transports, both settling the same {code | error}
    // promise: the pre-registered vscode:// deep link (the browser hands the
    // code to our URI handler) or the default loopback server on 127.0.0.1.
    let redirectUri: string;
    let callback: Promise<LoopbackCallbackResult>;
    let finish: () => void;
    if (config.redirectUri !== undefined) {
      redirectUri = config.redirectUri;
      callback = new Promise<LoopbackCallbackResult>((resolve) => {
        this.pendingCallback = { state, resolve };
      });
      finish = () => {
        this.pendingCallback = undefined;
      };
    } else {
      const server = await startLoopbackServer({
        ports: config.callbackPorts,
        redirectPath: config.redirectPath,
        state,
      });
      redirectUri = server.redirectUri;
      callback = server.callback;
      finish = () => {
        server.dispose();
      };
      try {
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(server.redirectUri));
        if (external.scheme === "http" || external.scheme === "https") {
          redirectUri = external.toString();
        }
      } catch (error) {
        // Local desktop works without the mapping; remote just loses the
        // port forward and will likely fail — log and continue.
        this.log(
          `Okta callback URI mapping unavailable, using ${redirectUri}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {

      const authorizeUrl = new URL(`${config.issuer}${config.authorizePath}`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", config.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", scopes.join(" "));
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      this.onLoginUrl?.(authorizeUrl.toString());
      await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));

      const result = await raceWithTimeout(callback, config.loginTimeoutMs, () =>
        new Error(`Okta sign-in timed out after ${Math.ceil(config.loginTimeoutMs / 1000)}s`),
      );
      if ("error" in result) throw new Error(result.error);

      const response = await this.postToken(config, {
        grant_type: "authorization_code",
        code: result.code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: verifier,
      });
      const session: StoredOktaSession = {
        token: response.token,
        accountLabel: response.accountLabel,
        // Filled by the handler right after provisioning computes the
        // provider groups; empty here on purpose.
        providerNames: [],
      };
      await this.tokenStore.save(session);
      this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
      this.log(`Okta SSO signed in (${session.accountLabel})`);
      return this.toSession(session);
    } finally {
      finish();
    }
  }

  private async postToken(config: OktaSsoConfig, params: Record<string, string>): Promise<OktaTokenResponse> {
    const url = `${config.issuer}${config.tokenPath}`;
    const body = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`Okta token request to ${url} failed: ${describeFetchFailure(error)}`, { cause: error });
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorCode = isRecord(payload) && typeof payload["error"] === "string" ? payload["error"] : undefined;
      if (response.status === 400 || errorCode === "invalid_grant") {
        throw new OktaRefreshExpiredError(
          `Okta rejected the credentials (${errorCode ?? `HTTP ${response.status}`}); sign in again.`,
        );
      }
      throw new Error(`Okta token endpoint failed (HTTP ${response.status}): ${errorCode ?? "unknown error"}`);
    }
    if (!isRecord(payload) || typeof payload["access_token"] !== "string" || payload["access_token"].length === 0) {
      throw new Error(`Okta token response from ${url} is missing access_token.`);
    }
    const expiresInRaw = Number(payload["expires_in"]);
    const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;
    const token: TokenInfo = {
      accessToken: payload["access_token"],
      refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : "",
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      scope: typeof payload["scope"] === "string" ? payload["scope"] : "",
      tokenType: typeof payload["token_type"] === "string" ? payload["token_type"] : "Bearer",
      expiresIn,
    };
    return { token, accountLabel: accountLabelFromIdToken(payload["id_token"]) };
  }

  private toSession(stored: StoredOktaSession): vscode.AuthenticationSession {
    return {
      id: "okta-sso",
      accessToken: stored.token.accessToken,
      account: { id: "okta-sso", label: stored.accountLabel },
      scopes: stored.token.scope.split(/\s+/).filter((scope) => scope.length > 0),
    };
  }
}

function accountLabelFromIdToken(idToken: unknown): string {
  if (typeof idToken !== "string" || idToken.length === 0) return OKTA_PROVIDER_LABEL;
  try {
    const payloadSegment = idToken.split(".")[1] ?? "";
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf-8");
    const payload: unknown = JSON.parse(decoded);
    if (!isRecord(payload)) return OKTA_PROVIDER_LABEL;
    // Display only — never trusted for authorization decisions.
    const email = payload["email"];
    if (typeof email === "string" && email.length > 0) return email;
    const username = payload["preferred_username"];
    if (typeof username === "string" && username.length > 0) return username;
  } catch {
    // Malformed id_token: fall back to the generic label.
  }
  return OKTA_PROVIDER_LABEL;
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createError());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [];
  let current: Error | undefined = error;
  while (current !== undefined) {
    messages.push(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return [...new Set(messages)].join(": ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
