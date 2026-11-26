import * as vscode from "vscode";

import {
  describeManagedOAuthFailure,
  isBusinessMembershipRevokedCode,
  KIMI_CODE_OAUTH_KEY,
  KIMI_REGION_PROFILES,
  kimiRegionProfile,
  OAuthAccessDeniedError,
  OAuthWorkspaceSwitchError,
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

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_FETCH_TIMEOUT_MS = 4_000;
const MAX_AVATAR_CACHE_ENTRIES = 16;
const SAFE_AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const SAFE_DATA_AVATAR_RE = /^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,/i;
const avatarDataUriCache = new Map<string, string>();

async function resolveWebviewSafeAvatar(avatarUrl: string | undefined): Promise<string | undefined> {
  if (!avatarUrl) return undefined;
  if (SAFE_DATA_AVATAR_RE.test(avatarUrl)) return avatarUrl;

  let parsed: URL;
  try {
    parsed = new URL(avatarUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;

  const cached = avatarDataUriCache.get(parsed.href);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(parsed.href, {
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const rawMime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!SAFE_AVATAR_MIME_TYPES.has(rawMime)) return undefined;
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_AVATAR_BYTES) {
      return undefined;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
      return undefined;
    }
    const normalizedMime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
    const dataUri = `data:${normalizedMime};base64,${bytes.toString("base64")}`;
    if (avatarDataUriCache.size >= MAX_AVATAR_CACHE_ENTRIES) {
      const oldestKey = avatarDataUriCache.keys().next().value;
      if (oldestKey !== undefined) avatarDataUriCache.delete(oldestKey);
    }
    avatarDataUriCache.set(parsed.href, dataUri);
    return dataUri;
  } catch {
    return undefined;
  }
}

async function toAccountProfileSnapshot(
  profile: ManagedAccountProfile,
): Promise<AccountProfileSnapshot> {
  const safeAvatar = await resolveWebviewSafeAvatar(profile.avatar);
  return {
    nickname: profile.nickname,
    ...(safeAvatar !== undefined ? { avatar: safeAvatar } : {}),
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
  onRevoked: () => Promise<boolean>,
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
    const revoked = await onRevoked();
    return {
      kind: "error",
      message: revoked ? BUSINESS_MEMBERSHIP_REVOKED_MESSAGE : failure.message,
      ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
      ...(revoked ? { revoked: true } : {}),
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
        ctx.runtime.bumpAuthGeneration();
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
        ctx.runtime.bumpAuthGeneration();
        avatarDataUriCache.clear();
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
    const generation = ctx.runtime.authGeneration;
    try {
      const result = await ctx.harness.auth.getAccountProfile();
      if (result.kind === "error") {
        if (isBusinessMembershipRevokedCode(result.errorCode)) {
          if (generation !== ctx.runtime.authGeneration) {
            return {
              kind: "error",
              message: result.message,
              errorCode: result.errorCode,
            };
          }
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
        profile: await toAccountProfileSnapshot(result.profile),
      };
    } catch (error) {
      ctx.logError("Failed to fetch account profile", error);
      return mapManagedAuthFailure(error, async () => {
        if (generation !== ctx.runtime.authGeneration) return false;
        await ctx.runtime.handleBusinessMembershipRevoked();
        return true;
      });
    }
  },

  [Methods.SwitchWorkspace]: async (
    params: { target: WorkspaceTarget; fromType?: "personal" | "enterprise" },
    ctx,
  ): Promise<SwitchWorkspaceResponse> => {
    return ctx.runtime.enqueueAuthMutation(async () => {
      if (await ctx.runtime.hasBusyManagedSession()) {
        return {
          kind: "error",
          message: "Finish or stop the active response before switching workspaces.",
        };
      }
      try {
        const switched = await ctx.harness.auth.switchWorkspace(params.target);
        ctx.runtime.bumpAuthGeneration();
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
            ? { profile: await toAccountProfileSnapshot(switched.profile) }
            : {}),
          ...(switched.warning !== undefined ? { warning: switched.warning } : {}),
        };
      } catch (error) {
        if (error instanceof OAuthWorkspaceSwitchError && error.committed) {
          ctx.runtime.bumpAuthGeneration();
        }
        ctx.logError("Kimi workspace switch failed", error);
        return mapManagedAuthFailure(error, async () => {
          await ctx.runtime.performBusinessMembershipRevocation();
          return true;
        });
      }
    });
  },
};
