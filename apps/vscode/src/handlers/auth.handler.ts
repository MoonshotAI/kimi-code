import * as vscode from "vscode";

import {
  KIMI_CODE_OAUTH_KEY,
  KIMI_REGION_PROFILES,
  kimiRegionProfile,
  OAuthAccessDeniedError,
  type KimiRegion,
} from "@moonshot-ai/kimi-code-oauth";
import { resolveKimiHome } from "@moonshot-ai/kimi-code-sdk";

import { Events, Methods } from "../../shared/bridge";
import type { LoginResult } from "../../shared/legacy-sdk";
import type { LoginStatus } from "../../shared/types";
import { updateLoginContext } from "../utils/context";
import { readPersistedKimiOAuthRef, resolveExtensionRegion } from "../utils/region";
import type { Handler } from "./types";

function regionForLogin(): KimiRegion | undefined {
  const homeDir = resolveKimiHome();
  const oauth = readPersistedKimiOAuthRef(homeDir);
  if (oauth !== undefined) {
    if (oauth.key === KIMI_CODE_OAUTH_KEY) return "mainland-cn";
    if (
      oauth.oauthHost !== undefined &&
      oauth.oauthHost.replace(/\/+$/, "") === KIMI_REGION_PROFILES.global.oauthHost
    ) {
      return "global";
    }
    return undefined;
  }
  return resolveExtensionRegion({ homeDir, refresh: true }).region;
}

export const authHandlers: Record<string, Handler<any, any>> = {
  [Methods.CheckLoginStatus]: async (_, ctx): Promise<LoginStatus> => {
    const region = regionForLogin() ?? "mainland-cn";
    return {
      loggedIn: await updateLoginContext(ctx.harness),
      siteBase: kimiRegionProfile(region).siteBase,
    };
  },

  [Methods.Login]: async (_, ctx): Promise<LoginResult> => {
    try {
      await ctx.harness.auth.login(undefined, {
        region: regionForLogin(),
        onDeviceCode: async (authorization) => {
          const url = authorization.verificationUriComplete || authorization.verificationUri;
          ctx.broadcast(Events.LoginUrl, { url }, ctx.webviewId);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        },
      });
      await updateLoginContext(ctx.harness);
      resolveExtensionRegion({ homeDir: resolveKimiHome(), refresh: true });
      return { success: true };
    } catch (error) {
      ctx.logError("Kimi login failed", error);
      await updateLoginContext(ctx.harness).catch((statusError: unknown) => {
        ctx.logError("Unable to refresh login status after a failed login", statusError);
      });
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: error instanceof OAuthAccessDeniedError ? `Login cancelled: ${message}` : message,
      };
    }
  },

  [Methods.Logout]: async (_, ctx): Promise<LoginResult> => {
    try {
      await ctx.harness.auth.logout();
      await updateLoginContext(ctx.harness);
      resolveExtensionRegion({ homeDir: resolveKimiHome(), refresh: true });
      return { success: true };
    } catch (error) {
      ctx.logError("Kimi logout failed", error);
      await updateLoginContext(ctx.harness).catch((statusError: unknown) => {
        ctx.logError("Unable to refresh login status after a failed logout", statusError);
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
