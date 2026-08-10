/**
 * Local Kimi managed-auth facade — device flow + config persistence,
 * replacing the node-sdk `KimiAuthFacade` (G-1 vscode localization). Ported
 * from `kimi-code-oauth` / `kimi-oauth`: form POSTs to
 * `{oauthHost}/api/oauth/*`; the granted token is persisted as
 * `providers.kimi.apiKey` via `config/set` (null-patch delete on logout).
 */

import type { EngineRpcClient } from "./rpc-client";

const OAUTH_HOST = "https://kimi.moonshot.cn";
const CLIENT_ID = "kimicode-cli";

/** Device-flow authorization info surfaced to `onDeviceCode` (camelCase,
 *  matching what vscode's `auth.handler` consumes). */
export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn?: number;
  readonly interval?: number;
}

interface DevicePollResult {
  readonly status: "pending" | "success" | "expired" | "denied";
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

export interface KimiAuthLoginOptions {
  readonly onDeviceCode?: (authorization: DeviceAuthorization) => Promise<void> | void;
  readonly baseUrl?: string;
}

/** The local auth facade (`harness.auth`). */
export class LocalKimiAuth {
  constructor(private readonly rpc: EngineRpcClient) {}

  async status(): Promise<{ providers: readonly { hasToken: boolean }[] }> {
    const config = (await this.rpc.call("config/get", {})) as Record<string, unknown>;
    const providers = (config["providers"] ?? {}) as Record<string, unknown>;
    const kimi = (providers["kimi"] ?? {}) as Record<string, unknown>;
    const apiKey = kimi["apiKey"];
    const hasToken = typeof apiKey === "string" && apiKey.length > 0;
    return { providers: [{ hasToken }] };
  }

  async login(providerName?: string, options?: KimiAuthLoginOptions): Promise<unknown> {
    const host = (options?.baseUrl ?? OAUTH_HOST).replace(/\/+$/, "");
    const authorization = await requestDeviceAuthorization(host);
    await options?.onDeviceCode?.(authorization);
    const token = await pollDeviceToken(host, authorization);
    await this.rpc.call("config/set", {
      patch: { providers: { [providerName ?? "kimi"]: { apiKey: token.access_token } } },
    });
    return { ok: true };
  }

  async logout(): Promise<unknown> {
    await this.rpc.call("config/set", { patch: { providers: { kimi: null } } });
    return { ok: true };
  }
}

async function requestDeviceAuthorization(host: string): Promise<DeviceAuthorization> {
  const response = await fetch(`${host}/api/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(`Device authorization failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as Record<string, unknown>;
  return {
    deviceCode: typeof raw["device_code"] === "string" ? raw["device_code"] : "",
    userCode: typeof raw["user_code"] === "string" ? raw["user_code"] : "",
    verificationUri: typeof raw["verification_uri"] === "string" ? raw["verification_uri"] : "",
    ...(typeof raw["verification_uri_complete"] === "string"
      ? { verificationUriComplete: raw["verification_uri_complete"] }
      : {}),
    ...(typeof raw["expires_in"] === "number" ? { expiresIn: raw["expires_in"] } : {}),
    ...(typeof raw["interval"] === "number" ? { interval: raw["interval"] } : {}),
  };
}

async function pollDeviceToken(
  host: string,
  authorization: DeviceAuthorization,
): Promise<{ access_token: string }> {
  const intervalMs = (authorization.interval ?? 5) * 1000;
  const maxPolls = Math.ceil((authorization.expiresIn ?? 600) / (authorization.interval ?? 5));
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    await sleep(intervalMs);
    const response = await fetch(`${host}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: authorization.deviceCode,
      }),
    });
    if (!response.ok) {
      throw new Error(`Token request failed: HTTP ${response.status}`);
    }
    const result = (await response.json()) as DevicePollResult;
    switch (result.status) {
      case "success":
        if (result.access_token === undefined) {
          throw new Error("Token response missing access_token");
        }
        return { access_token: result.access_token };
      case "expired":
        throw new Error("Device code expired; please try again.");
      case "denied":
        throw new Error("Login was denied.");
      case "pending":
        break;
    }
  }
  throw new Error("Login timed out; please try again.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
