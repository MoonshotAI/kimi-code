import * as vscode from "vscode";

import { Events, Methods } from "../../shared/bridge";
import type { LoginResult } from "../../shared/legacy-sdk";
import { OKTA_PROVIDER_ID, oktaScopes } from "../okta/auth-provider";
import { provisionOktaModels, removeOktaProviders } from "../okta/models";
import { ensureOktaRuntime, readOktaMode, requireGatewayConfig, requireOktaConfig, type OktaRuntime } from "../okta/runtime";
import type { Handler } from "./types";

export interface OktaStatusResult {
  readonly configured: boolean;
  readonly loggedIn: boolean;
  readonly providerNames: readonly string[];
}

export interface AuthModeResult {
  readonly mode: "okta" | "kimi";
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const oktaHandlers: Record<string, Handler<any, any>> = {
  [Methods.OktaLogin]: async (_, ctx): Promise<LoginResult> => {
    let okta: OktaRuntime;
    try {
      okta = ensureOktaRuntime(ctx.harness);
    } catch (error) {
      ctx.logError("Okta module unavailable", error);
      return { success: false, error: errorMessage(error) };
    }
    let config;
    try {
      config = requireOktaConfig(ctx.harness);
    } catch (error) {
      ctx.logError("Okta SSO is not configured", error);
      return { success: false, error: errorMessage(error) };
    }
    let gateway;
    try {
      gateway = requireGatewayConfig(ctx.harness);
    } catch (error) {
      ctx.logError("The gateway is not configured", error);
      return { success: false, error: errorMessage(error) };
    }
    okta.provider.onLoginUrl = (url) => {
      ctx.broadcast(Events.OktaLoginUrl, { url }, ctx.webviewId);
    };
    try {
      const session = await vscode.authentication.getSession(OKTA_PROVIDER_ID, oktaScopes(config), {
        createIfNone: true,
      });
      if (session === undefined) {
        return { success: false, error: "Okta sign-in was not completed." };
      }
      const provisioned = await provisionOktaModels({
        harness: okta.harness,
        gateway,
        accessToken: session.accessToken,
      });
      // Persist the generated provider group names so the config-free
      // restore after a reload injects the token into every one of them.
      await okta.tokenStore.updateProviderNames(provisioned.providerNames);
      return { success: true };
    } catch (error) {
      ctx.logError("Okta login failed", error);
      return {
        success: false,
        error: errorMessage(error),
      };
    }
  },

  [Methods.OktaStatus]: async (_, ctx): Promise<OktaStatusResult> => {
    const mode = readOktaMode(ctx.harness);
    if (mode.error !== null) {
      ctx.logError("Okta SSO is misconfigured", mode.error);
      return { configured: false, loggedIn: false, providerNames: [] };
    }
    if (mode.mode === "kimi") {
      return { configured: false, loggedIn: false, providerNames: [] };
    }
    try {
      const okta = ensureOktaRuntime(ctx.harness);
      const stored = await okta.tokenStore.load();
      return {
        configured: true,
        loggedIn: (stored?.token.accessToken.length ?? 0) > 0,
        providerNames: stored?.providerNames ?? [],
      };
    } catch {
      return { configured: false, loggedIn: false, providerNames: [] };
    }
  },

  [Methods.OktaLogout]: async (_, ctx): Promise<LoginResult> => {
    let okta: OktaRuntime;
    try {
      okta = ensureOktaRuntime(ctx.harness);
    } catch (error) {
      ctx.logError("Okta module unavailable", error);
      return { success: false, error: errorMessage(error) };
    }
    const providerNames = (await okta.tokenStore.load())?.providerNames ?? [];
    try {
      await okta.tokenStore.clear();
      await okta.provider.removeSession();
      await removeOktaProviders(okta.harness, providerNames);
      return { success: true };
    } catch (error) {
      ctx.logError("Okta logout failed", error);
      return {
        success: false,
        error: errorMessage(error),
      };
    }
  },

  [Methods.GetAuthMode]: async (_, ctx): Promise<AuthModeResult> => {
    return readOktaMode(ctx.harness);
  },
};
