/**
 * Okta IdP configuration, loaded from `<homeDir>/okta.json` (default
 * `~/.kimi-code/okta.json`) — the identity side ONLY (issuer, client,
 * endpoints, ports). Your own gateway API lives in gateway.json next to it.
 * Okta is the DEFAULT login mode; the file only arms the module. Set
 * `"authMode": "kimi"` to fall back to the built-in Kimi login screen.
 *
 * Example file:
 * {
 *   "issuer": "https://example.okta.com",
 *   "clientId": "0oa1abcd2EFgHiJkLmN3",
 *   "redirectUri": "vscode://life-restver-rd.restver-code/callback",
 *   "scopes": "openid profile email offline_access",
 *   "authorizePath": "/v1/authorize",
 *   "tokenPath": "/v1/token",
 *   "callbackPorts": [35173, 35174, 35175],
 *   "redirectPath": "/callback",
 *   "loginTimeoutMs": 600000,
 *   "authMode": "okta"
 * }
 *
 * The Okta application must be an OIDC client with PKCE (S256) required and
 * `http://localhost:<port><redirectPath>` registered as a redirect URI for
 * every port in `callbackPorts`. Access tokens must live at least ~10 minutes
 * so the extension-host refresh timer (TTL/2, 5-minute tick) can keep the
 * engine-injected credential ahead of expiry.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface OktaSsoConfig {
  readonly issuer: string;
  readonly clientId: string;
  /**
   * Pre-registered vscode:// deep-link redirect (Continue-style): when set,
   * the browser hands the code straight to this extension's URI handler
   * instead of a loopback server. Must match the extension's
   * publisher.name routing (vscode://<publisher>.<extension>/...) AND the
   * Okta app's registered redirect URI. Unset → loopback callback.
   */
  readonly redirectUri: string | undefined;
  readonly scopes: string;
  readonly authorizePath: string;
  readonly tokenPath: string;
  readonly callbackPorts: readonly number[];
  readonly redirectPath: string;
  readonly loginTimeoutMs: number;
  /** Login surface selector: "okta" (default) or the built-in "kimi" screen. */
  readonly authMode: "okta" | "kimi";
}

export const OKTA_CONFIG_FILENAME = "okta.json";

const DEFAULT_SCOPES = "openid profile email offline_access";
const DEFAULT_AUTHORIZE_PATH = "/v1/authorize";
const DEFAULT_TOKEN_PATH = "/v1/token";
const DEFAULT_CALLBACK_PORTS = [35173, 35174, 35175];
const DEFAULT_REDIRECT_PATH = "/callback";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

interface ConfigCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly config: OktaSsoConfig | undefined;
}

const configCache = new Map<string, ConfigCacheEntry>();

export function oktaConfigPath(homeDir: string): string {
  return join(homeDir, OKTA_CONFIG_FILENAME);
}

export function clearOktaConfigCache(): void {
  configCache.clear();
}

export function loadOktaConfig(homeDir: string): OktaSsoConfig | undefined {
  const path = oktaConfigPath(homeDir);
  let mtimeMs = 0;
  let size = -1;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    configCache.delete(homeDir);
    return undefined;
  }
  const cached = configCache.get(homeDir);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.config;
  }
  const config = parseOktaConfig(path);
  configCache.set(homeDir, { mtimeMs, size, config });
  return config;
}

function parseOktaConfig(path: string): OktaSsoConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid Okta SSO config (${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid Okta SSO config (${path}): expected a JSON object.`);
  }
  const issuer = requireHttpsUrl(raw, "issuer", path);
  const clientId = requireNonEmptyString(raw, "clientId", path);
  const callbackPorts = Array.isArray(raw["callbackPorts"])
    ? raw["callbackPorts"].filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536)
    : [];
  return {
    issuer,
    clientId,
    redirectUri: typeof raw["redirectUri"] === "string" && raw["redirectUri"].trim().length > 0
      ? raw["redirectUri"].trim()
      : undefined,
    scopes: typeof raw["scopes"] === "string" && raw["scopes"].length > 0 ? raw["scopes"] : DEFAULT_SCOPES,
    authorizePath:
      typeof raw["authorizePath"] === "string" && raw["authorizePath"].startsWith("/")
        ? raw["authorizePath"]
        : DEFAULT_AUTHORIZE_PATH,
    tokenPath:
      typeof raw["tokenPath"] === "string" && raw["tokenPath"].startsWith("/")
        ? raw["tokenPath"]
        : DEFAULT_TOKEN_PATH,
    callbackPorts: callbackPorts.length > 0 ? callbackPorts : DEFAULT_CALLBACK_PORTS,
    redirectPath:
      typeof raw["redirectPath"] === "string" && raw["redirectPath"].startsWith("/")
        ? raw["redirectPath"]
        : DEFAULT_REDIRECT_PATH,
    loginTimeoutMs:
      typeof raw["loginTimeoutMs"] === "number" && Number.isInteger(raw["loginTimeoutMs"]) && raw["loginTimeoutMs"] > 0
        ? raw["loginTimeoutMs"]
        : DEFAULT_LOGIN_TIMEOUT_MS,
    authMode: parseAuthMode(raw, path),
  };
}

function parseAuthMode(raw: Record<string, unknown>, path: string): "okta" | "kimi" {
  const value = raw["authMode"];
  if (value === undefined) return "okta";
  if (value === "okta" || value === "kimi") return value;
  throw new Error(`Invalid Okta SSO config (${path}): "authMode" must be "okta" or "kimi" (got ${JSON.stringify(value)}).`);
}

function requireNonEmptyString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid Okta SSO config (${path}): "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireHttpsUrl(record: Record<string, unknown>, field: string, path: string): string {
  const value = requireNonEmptyString(record, field, path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Okta SSO config (${path}): "${field}" must be a URL (got "${value}").`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid Okta SSO config (${path}): "${field}" must use https (got "${value}").`);
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
