import * as vscode from "vscode";

import {
  describeManagedOAuthFailure,
  isBusinessMembershipRevokedCode,
  KIMI_CODE_OAUTH_KEY,
  KIMI_REGION_PROFILES,
  kimiRegionProfile,
  OAuthAccessDeniedError,
  type KimiRegion,
  type ManagedAccountProfile,
} from "@moonshot-ai/kimi-code-oauth";
import { resolveKimiHome } from "@moonshot-ai/kimi-code-sdk";
import { track } from "@moonshot-ai/kimi-telemetry";

import { Events, Methods } from "../../shared/bridge";
import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from "../../shared/errors";
import type { LoginResult } from "../../shared/legacy-sdk";
import type {
  AccountProfileResponse,
  AccountProfileSnapshot,
  LoginStatus,
  SwitchWorkspaceResponse,
  WorkspaceTarget,
} from "../../shared/types";
import { updateLoginContext } from "../utils/context";
import { readPersistedKimiOAuthRef, resolveExtensionRegion } from "../utils/region";
import type { Handler } from "./types";

function toAccountProfileSnapshot(profile: ManagedAccountProfile): AccountProfileSnapshot {
  return {
    nickname: profile.nickname,
    ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
    userLevelName: profile.userLevelName,
    hasBusinessWorkspace: profile.hasBusinessWorkspace,
    activeWorkspaceName: profile.activeWorkspaceName,
    workspaces: profile.workspaces.map((ws) => ({
      kind: ws.kind,
      key: ws.key,
      ...(ws.kind === "business" ? { businessId: ws.businessId, status: ws.status } : {}),
      name: ws.name,
      current: ws.current,
      disabled: ws.disabled,
      switchable: ws.switchable,
      roles: [...ws.roles],
    })),
  };
}

async function mapManagedAuthFailure(
  error: unknown,
  onRevoked: () => Promise<void>,
): Promise<{
  readonly kind: "error";
  readonly message: string;
  readonly errorCode?: string;
  readonly revoked?: boolean;
}> {
  const failure = describeManagedOAuthFailure(error);
  if (
    isBusinessMembershipRevokedCode(failure.errorCode) ||
    failure.message === BUSINESS_MEMBERSHIP_REVOKED_MESSAGE
  ) {
    await onRevoked();
    return {
      kind: "error",
      message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
      ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
      revoked: true,
    };
  }
  return {
    kind: "error",
    message: failure.message,
    ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
  };
}

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
    return ctx.runtime.enqueueAuthMutation(async () => {
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
        try {
          resolveExtensionRegion({ homeDir: ctx.harness.homeDir ?? resolveKimiHome(), refresh: true });
        } catch (regionError) {
          ctx.logError("Unable to refresh region after login", regionError);
        }
        await ctx.runtime.syncActiveSessionsModel();
        ctx.broadcast(Events.ModelCatalogChanged, {});
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
    });
  },

  [Methods.Logout]: async (_, ctx): Promise<LoginResult> => {
    return ctx.runtime.enqueueAuthMutation(async () => {
      try {
        await ctx.harness.auth.logout();
        await updateLoginContext(ctx.harness);
        try {
          resolveExtensionRegion({ homeDir: ctx.harness.homeDir ?? resolveKimiHome(), refresh: true });
        } catch (regionError) {
          ctx.logError("Unable to refresh region after logout", regionError);
        }
        await ctx.runtime.syncActiveSessionsModel();
        ctx.broadcast(Events.ModelCatalogChanged, {});
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
    });
  },

  [Methods.GetAccountProfile]: async (_, ctx): Promise<AccountProfileResponse> => {
    try {
      const result = await ctx.harness.auth.getAccountProfile();
      if (result.kind === "error") {
        if (isBusinessMembershipRevokedCode(result.errorCode)) {
          await ctx.runtime.handleBusinessMembershipRevoked();
          return {
            kind: "error",
            message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
            errorCode: result.errorCode,
            revoked: true,
          };
        }
        return {
          kind: "error",
          message: result.message,
          ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
        };
      }
      return {
        kind: "ok",
        profile: toAccountProfileSnapshot(result.profile),
      };
    } catch (error) {
      ctx.logError("Failed to fetch account profile", error);
      return mapManagedAuthFailure(error, () => ctx.runtime.handleBusinessMembershipRevoked());
    }
  },

  [Methods.SwitchWorkspace]: async (
    params: { target: WorkspaceTarget; fromType?: "personal" | "enterprise" },
    ctx,
  ): Promise<SwitchWorkspaceResponse> => {
    return ctx.runtime.enqueueAuthMutation(async () => {
      try {
        const switched = await ctx.harness.auth.switchWorkspace(params.target);
        const loggedIn = await updateLoginContext(ctx.harness);
        if (!loggedIn) {
          return {
            kind: "error",
            message: "Not logged in to Kimi Code.",
          };
        }
        track("identity_switch", {
          from_type: params.fromType ?? "personal",
          to_type: params.target.kind === "business" ? "enterprise" : "personal",
          enterprise_id: params.target.kind === "business" ? params.target.businessId : "",
        });
        try {
          resolveExtensionRegion({ homeDir: ctx.harness.homeDir ?? resolveKimiHome(), refresh: true });
        } catch (regionError) {
          ctx.logError("Unable to refresh region after workspace switch", regionError);
        }
        await ctx.runtime.syncActiveSessionsModel();
        ctx.broadcast(Events.ModelCatalogChanged, {});
        return {
          kind: "ok",
          target: switched.target,
          ...(switched.profile !== undefined
            ? { profile: toAccountProfileSnapshot(switched.profile) }
            : {}),
          ...(switched.warning !== undefined ? { warning: switched.warning } : {}),
        };
      } catch (error) {
        ctx.logError("Kimi workspace switch failed", error);
        return mapManagedAuthFailure(error, () => ctx.runtime.performBusinessMembershipRevocation());
      }
    });
  },
};
