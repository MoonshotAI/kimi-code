import * as vscode from "vscode";

import { Events, Methods } from "../../shared/bridge";
import type { LoginResult } from "../../shared/legacy-sdk";
import type { LoginStatus } from "../../shared/types";
import { updateLoginContext } from "../utils/context";
import type { Handler } from "./types";

export const authHandlers: Record<string, Handler<any, any>> = {
  [Methods.CheckLoginStatus]: async (_, ctx): Promise<LoginStatus> => {
    return { loggedIn: await updateLoginContext(ctx.harness) };
  },

  [Methods.Login]: async (_, ctx): Promise<LoginResult> => {
    try {
      await ctx.harness.auth.login(undefined, {
        onDeviceCode: async (authorization) => {
          const url = authorization.verificationUriComplete || authorization.verificationUri;
          ctx.broadcast(Events.LoginUrl, { url }, ctx.webviewId);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        },
      });
      await updateLoginContext(ctx.harness);
      return { success: true };
    } catch (error) {
      ctx.logError("Kimi login failed", error);
      await updateLoginContext(ctx.harness).catch((statusError: unknown) => {
        ctx.logError("Unable to refresh login status after a failed login", statusError);
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  [Methods.Logout]: async (_, ctx): Promise<LoginResult> => {
    try {
      await ctx.harness.auth.logout();
      await updateLoginContext(ctx.harness);
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
