/**
 * Extension-host singleton for the Okta SSO module. `initOktaModule` runs
 * once from `activate()`: it registers the VS Code authentication provider
 * (no okta.json needed — the provider resolves config lazily at call time)
 * and kicks off `restoreOnActivation`, which re-injects the stored session
 * into the fresh engine process's memory config. Reading okta.json happens
 * ONLY when a flow actually needs it: sign-in, refresh, model provisioning,
 * and the mode answer for the login gate.
 *
 * `initOktaModule` never throws: without a stored session the module is
 * inert until the first Okta RPC, and a missing/invalid okta.json surfaces
 * on the Okta login page (via GetAuthMode / oktaLogin) instead of the log.
 */
import * as vscode from "vscode";

import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

import { OktaAuthenticationProvider, OKTA_PROVIDER_ID, OKTA_PROVIDER_LABEL } from "./auth-provider";
import { loadGatewayConfig, type GatewayConfig } from "./gateway-config";
import { loadOktaConfig, type OktaSsoConfig } from "./okta-config";
import { OktaTokenStore, createEngineInjector } from "./token-store";

export interface OktaRuntime {
  readonly tokenStore: OktaTokenStore;
  readonly provider: OktaAuthenticationProvider;
  readonly harness: KimiHarness;
  readonly disposables: readonly vscode.Disposable[];
}

interface OktaModuleContext {
  readonly secrets: vscode.SecretStorage;
  readonly log: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
}

let moduleContext: OktaModuleContext | undefined;
let runtime: OktaRuntime | undefined;

export function getOktaRuntime(): OktaRuntime | undefined {
  return runtime;
}

/** Register the provider and restore the previous session. Never throws. */
export function initOktaModule(options: {
  readonly context: vscode.ExtensionContext;
  readonly harness: KimiHarness;
  readonly log: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
}): void {
  try {
    moduleContext = {
      secrets: options.context.secrets,
      log: options.log,
      logError: options.logError,
    };
    ensureOktaRuntime(options.harness);
  } catch (error) {
    options.logError("Okta SSO module failed to start", error);
  }
}

/**
 * Cheap, side-effect-free mode answer for the login gate. Reads okta.json
 * directly (memoized by the config loader); never boots the module. Errors
 * come back as `{ mode: "okta", error }` so the Okta page can show them —
 * Okta stays the default either way.
 */
export function readOktaMode(harness: KimiHarness): { mode: "okta" | "kimi"; error: string | null } {
  try {
    const config = loadOktaConfig(harness.homeDir);
    if (config?.authMode === "kimi") return { mode: "kimi", error: null };
    if (config === undefined) {
      return {
        mode: "okta",
        error: "Okta SSO is not configured. Create ~/.kimi-code/okta.json (issuer, clientId) and gateway.json (apiBaseUrl) to enable it.",
      };
    }
    return { mode: "okta", error: null };
  } catch (error) {
    return { mode: "okta", error: error instanceof Error ? error.message : String(error) };
  }
}

/** okta.json (the IdP side) for flows that need it: sign-in, refresh, mode. */
export function requireOktaConfig(harness: KimiHarness): OktaSsoConfig {
  const config = loadOktaConfig(harness.homeDir);
  if (config === undefined) {
    throw new Error("Okta SSO is not configured. Create ~/.kimi-code/okta.json (issuer, clientId) and gateway.json (apiBaseUrl) to enable it.");
  }
  return config;
}

/** gateway.json (your own API) for model provisioning after sign-in. */
export function requireGatewayConfig(harness: KimiHarness): GatewayConfig {
  const gateway = loadGatewayConfig(harness.homeDir);
  if (gateway === undefined) {
    throw new Error("The gateway is not configured. Create ~/.kimi-code/gateway.json (apiBaseUrl) to enable model provisioning.");
  }
  return gateway;
}

/** Idempotent: the runtime is built once per harness (activation or first RPC). */
export function ensureOktaRuntime(harness: KimiHarness): OktaRuntime {
  if (runtime !== undefined && runtime.harness === harness) return runtime;
  if (runtime !== undefined) disposeRuntime();
  const host = moduleContext;
  if (host === undefined) {
    throw new Error("Okta module context is not initialized; extension activation did not run.");
  }
  const tokenStore = new OktaTokenStore({ secrets: host.secrets, logError: host.logError });
  const provider = new OktaAuthenticationProvider({
    harness,
    tokenStore,
    log: host.log,
    logError: host.logError,
  });
  tokenStore.setEngineInjector(createEngineInjector(harness));
  const registration = vscode.authentication.registerAuthenticationProvider(OKTA_PROVIDER_ID, OKTA_PROVIDER_LABEL, provider, {
    supportsMultipleAccounts: false,
  });
  // Receives vscode:// deep-link callbacks when okta.json sets redirectUri.
  const uriHandler = vscode.window.registerUriHandler({ handleUri: (uri) => provider.handleUri(uri) });
  runtime = { tokenStore, provider, harness, disposables: [registration, uriHandler, provider] };
  void provider.restoreOnActivation();
  return runtime;
}

function disposeRuntime(): void {
  const current = runtime;
  if (current === undefined) return;
  runtime = undefined;
  current.tokenStore.stopRefreshTimer();
  for (const disposable of current.disposables) {
    disposable.dispose();
  }
}
