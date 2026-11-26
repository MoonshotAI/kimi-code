import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  ManagedUserInfo,
  ManagedWorkspace,
  ManagedWorkspacesResult,
  ManagedWorkspaceTarget,
} from '@moonshot-ai/app-core/api';
import {
  isBusinessMembershipRevokedCode,
  isDaemonApiError,
  SERVER_AUTH_UNAUTHORIZED_CODE,
} from '@moonshot-ai/app-core/api';
import { classifyConnectIssue, isFreePlan, type ConnectIssue } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { track } from '../contracts';
import type { ManagedMembership } from '../client/types';
import { clientPinia } from './pinia';
import { modelsStore } from './models';
import { warningsStore } from './warnings';

export type AuthCheckResult = 'proceed' | 'retry' | 'server-auth-required';

export type SwitchManagedWorkspaceOutcome =
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly revoked?: boolean; readonly message?: string };

export interface AuthHooks {
  reload: () => Promise<void>;
}

const MAX_RECENT_WORKSPACE_KEYS = 10;

let authHooks: AuthHooks | null = null;

export function setAuthHooks(next: AuthHooks | null): void {
  authHooks = next;
}

function normalizeWorkspacesWithNickname(
  workspaces: readonly ManagedWorkspace[],
  nickname: string | undefined,
): readonly ManagedWorkspace[] {
  const trimmed = nickname?.trim() ?? '';
  if (trimmed === '') return workspaces;
  return workspaces.map((entry) =>
    entry.kind === 'personal' && entry.name === 'Personal' ? { ...entry, name: trimmed } : entry,
  );
}

export const useAuthStore = defineStore('kimi.auth', () => {
  const managedProviderStatus = ref<string | null>(null);
  const managedUserInfo = ref<ManagedUserInfo | null>(null);
  const managedMembership = ref<ManagedMembership>(null);
  const managedWorkspaces = ref<readonly ManagedWorkspace[]>([]);
  const managedWorkspacesLoaded = ref(false);
  const managedWorkspacesLoading = ref(false);
  const managedWorkspacesError = ref<string | null>(null);
  const switchingWorkspaceKey = ref<string | null>(null);
  const switchingWorkspaceName = ref<string | null>(null);
  const recentWorkspaceKeys = ref<string[]>([]);
  const businessMembershipRevokedOpen = ref(false);
  const authChecked = ref(false);
  const connectIssue = ref<ConnectIssue | null>(null);

  const signedIn = computed(() => managedProviderStatus.value === 'authenticated');
  const isFree = computed(() => managedMembership.value === 'free');
  const hasBusinessWorkspace = computed(
    () =>
      managedWorkspaces.value.some((entry) => entry.kind === 'business') ||
      Boolean(managedUserInfo.value?.workspaceName),
  );
  const currentManagedWorkspace = computed<ManagedWorkspace | null>(
    () => managedWorkspaces.value.find((entry) => entry.current) ?? null,
  );

  let checkAuthFlight: Promise<AuthCheckResult> | null = null;
  let checkAuthDirty = false;
  let epoch = 0;

  let userInfoFetchGeneration = 0;
  let workspacesFetchGeneration = 0;
  let membershipFlight: Promise<void> | null = null;
  let switchWorkspaceFlight: Promise<SwitchManagedWorkspaceOutcome> | null = null;
  let revokingFlight: Promise<void> | null = null;
  let revocationLogoutPending = false;

  function recordRecentWorkspaceKey(key: string | undefined): void {
    if (!key) return;
    recentWorkspaceKeys.value = [
      key,
      ...recentWorkspaceKeys.value.filter((existing) => existing !== key),
    ].slice(0, MAX_RECENT_WORKSPACE_KEYS);
  }

  function clearWorkspaceState(): void {
    managedWorkspaces.value = [];
    managedWorkspacesLoaded.value = false;
    managedWorkspacesLoading.value = false;
    managedWorkspacesError.value = null;
    switchingWorkspaceKey.value = null;
    switchingWorkspaceName.value = null;
    recentWorkspaceKeys.value = [];
  }

  function applyWorkspacesResult(wsResult: ManagedWorkspacesResult): boolean {
    if (wsResult.kind === 'ok') {
      const normalized = normalizeWorkspacesWithNickname(
        wsResult.workspaces,
        managedUserInfo.value?.nickname,
      );
      managedWorkspaces.value = normalized;
      managedWorkspacesLoaded.value = true;
      managedWorkspacesError.value = null;
      recordRecentWorkspaceKey(normalized.find((entry) => entry.current)?.key);
      return false;
    }
    managedWorkspacesError.value = wsResult.message;
    return isBusinessMembershipRevokedCode(wsResult.errorCode);
  }

  async function fetchUserInfo(generation: number): Promise<void> {
    const api = getKimiWebApi();
    let revoked = false;
    try {
      const infoResult = await api.getUserInfo();
      if (generation !== userInfoFetchGeneration) return;
      if (managedProviderStatus.value !== 'authenticated') return;
      if (infoResult.kind === 'ok') {
        managedUserInfo.value = infoResult.userInfo;
        managedMembership.value = isFreePlan(
          infoResult.userInfo.userLevel,
          infoResult.userInfo.goodsVersion,
        )
          ? 'free'
          : 'member';
        if (managedWorkspaces.value.length > 0) {
          managedWorkspaces.value = normalizeWorkspacesWithNickname(
            managedWorkspaces.value,
            infoResult.userInfo.nickname,
          );
        }
      } else {
        managedUserInfo.value = null;
        managedMembership.value = infoResult.status === 402 ? 'free' : null;
        if (isBusinessMembershipRevokedCode(infoResult.errorCode)) {
          revoked = true;
        }
      }
    } catch {
      if (generation !== userInfoFetchGeneration) return;
      if (managedProviderStatus.value !== 'authenticated') return;
      managedUserInfo.value = null;
      managedMembership.value = null;
    }

    if (revoked) {
      void handleBusinessMembershipRevoked();
    }
  }

  function trackMembershipFlight(generation: number): Promise<void> {
    const flight = fetchUserInfo(generation).finally(() => {
      if (membershipFlight === flight) membershipFlight = null;
    });
    membershipFlight = flight;
    return flight;
  }

  async function probeMembership(): Promise<void> {
    if (managedProviderStatus.value !== 'authenticated') return;
    if (!managedWorkspacesLoaded.value && !managedWorkspacesLoading.value) {
      void reloadManagedWorkspaces();
    }
    if (membershipFlight !== null) return membershipFlight;
    await trackMembershipFlight(++userInfoFetchGeneration);
  }

  async function reloadManagedWorkspaces(): Promise<void> {
    if (managedProviderStatus.value !== 'authenticated') return;
    const api = getKimiWebApi();
    if (typeof api.listManagedWorkspaces !== 'function') return;
    const generation = ++workspacesFetchGeneration;
    managedWorkspacesLoading.value = true;
    try {
      const wsResult = await api.listManagedWorkspaces();
      if (generation !== workspacesFetchGeneration || managedProviderStatus.value !== 'authenticated') return;
      if (applyWorkspacesResult(wsResult)) {
        void handleBusinessMembershipRevoked();
      }
    } catch (err) {
      if (generation !== workspacesFetchGeneration || managedProviderStatus.value !== 'authenticated') return;
      managedWorkspacesError.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation === workspacesFetchGeneration) {
        managedWorkspacesLoading.value = false;
      }
    }
  }

  function applyCommittedWorkspaceTarget(targetKey: string, targetName?: string): void {
    if (managedWorkspaces.value.length > 0) {
      const hasTarget = managedWorkspaces.value.some((entry) => entry.key === targetKey);
      managedWorkspaces.value = hasTarget
        ? managedWorkspaces.value.map((entry) => ({
            ...entry,
            current: entry.key === targetKey,
          }))
        : [];
    }
    if (managedUserInfo.value !== null) {
      if (targetKey === 'personal') {
        const { workspaceName: _removed, ...rest } = managedUserInfo.value;
        managedUserInfo.value = rest;
      } else if (targetName) {
        managedUserInfo.value = { ...managedUserInfo.value, workspaceName: targetName };
      }
    }
  }

  async function waitForWorkspaceSwitch(): Promise<boolean> {
    if (switchWorkspaceFlight === null) return false;
    await switchWorkspaceFlight.catch(() => undefined);
    return true;
  }

  function switchManagedWorkspace(
    target: ManagedWorkspaceTarget,
    displayName?: string,
  ): Promise<SwitchManagedWorkspaceOutcome> {
    if (switchingWorkspaceKey.value !== null || managedProviderStatus.value !== 'authenticated') {
      return Promise.resolve({ ok: false });
    }
    const api = getKimiWebApi();
    if (typeof api.switchManagedWorkspace !== 'function') {
      return Promise.resolve({ ok: false });
    }
    const flight = runSwitchManagedWorkspace(api, target, displayName).finally(() => {
      if (switchWorkspaceFlight === flight) {
        switchWorkspaceFlight = null;
      }
    });
    switchWorkspaceFlight = flight;
    return flight;
  }

  async function runSwitchManagedWorkspace(
    api: ReturnType<typeof getKimiWebApi>,
    target: ManagedWorkspaceTarget,
    displayName?: string,
  ): Promise<SwitchManagedWorkspaceOutcome> {
    const switchEpoch = epoch;
    const targetKey = target.kind === 'personal' ? 'personal' : `business:${target.businessId}`;
    const previousCurrent = currentManagedWorkspace.value;
    const fromType: 'personal' | 'enterprise' =
      previousCurrent?.kind === 'business' ||
      (previousCurrent === null && Boolean(managedUserInfo.value?.workspaceName))
        ? 'enterprise'
        : 'personal';
    const toType: 'personal' | 'enterprise' =
      target.kind === 'business' ? 'enterprise' : 'personal';

    switchingWorkspaceKey.value = targetKey;
    switchingWorkspaceName.value = displayName ?? null;
    try {
      const result = await api.switchManagedWorkspace!(target);
      if (switchEpoch !== epoch || managedProviderStatus.value !== 'authenticated') {
        return { ok: false, revoked: businessMembershipRevokedOpen.value };
      }
      if (result.kind === 'error') {
        if (isBusinessMembershipRevokedCode(result.errorCode)) {
          await handleBusinessMembershipRevoked();
          return { ok: false, revoked: true };
        }
        return { ok: false, message: result.message };
      }

      track('identity_switch', {
        from_type: fromType,
        to_type: toType,
        enterprise_id: target.kind === 'business' ? target.businessId : '',
      });
      recordRecentWorkspaceKey(previousCurrent?.key);
      recordRecentWorkspaceKey(targetKey);
      applyCommittedWorkspaceTarget(targetKey, displayName);
      managedWorkspacesError.value = null;

      await Promise.allSettled([
        trackMembershipFlight(++userInfoFetchGeneration),
        reloadManagedWorkspaces(),
      ]);
      if (
        switchEpoch !== epoch ||
        businessMembershipRevokedOpen.value ||
        managedProviderStatus.value !== 'authenticated'
      ) {
        return { ok: false, revoked: businessMembershipRevokedOpen.value };
      }
      const postSwitchWorkspaceError = managedWorkspacesError.value;
      await runCheckAuth(switchEpoch, undefined, true).catch(() => 'retry' as AuthCheckResult);
      if (
        switchEpoch !== epoch ||
        businessMembershipRevokedOpen.value ||
        managedProviderStatus.value !== 'authenticated'
      ) {
        return { ok: false, revoked: businessMembershipRevokedOpen.value };
      }
      const warnings: string[] = [];
      if (result.warning !== undefined) warnings.push(result.warning);
      if (postSwitchWorkspaceError !== null) warnings.push(postSwitchWorkspaceError);
      try {
        await authHooks?.reload?.();
      } catch (reloadErr) {
        warnings.push(reloadErr instanceof Error ? reloadErr.message : String(reloadErr));
      }
      const warning = warnings.length > 0 ? warnings.join(' ') : undefined;
      return {
        ok: true,
        ...(warning !== undefined ? { warning } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (switchingWorkspaceKey.value === targetKey) {
        switchingWorkspaceKey.value = null;
        switchingWorkspaceName.value = null;
      }
    }
  }

  function startRevocationCleanup(): Promise<void> {
    const flight = (async () => {
      const api = getKimiWebApi();
      if (typeof api.logout === 'function') {
        try {
          await api.logout();
          revocationLogoutPending = false;
        } catch (err) {
          warningsStore().pushOperationFailure('logout', err);
          return;
        }
      } else {
        revocationLogoutPending = false;
      }
      resetAuth({ keepRevokedModal: true });
      await checkAuth().catch(() => 'retry' as AuthCheckResult);
      await authHooks?.reload?.().catch(() => undefined);
    })().finally(() => {
      if (revokingFlight === flight) revokingFlight = null;
    });
    revokingFlight = flight;
    return flight;
  }

  function handleBusinessMembershipRevoked(): Promise<void> {
    if (revokingFlight !== null) return revokingFlight;
    businessMembershipRevokedOpen.value = true;
    revocationLogoutPending = true;
    resetAuth({ keepRevokedModal: true });
    return startRevocationCleanup();
  }

  async function acknowledgeBusinessMembershipRevoked(): Promise<boolean> {
    if (revokingFlight !== null) {
      await revokingFlight;
    }
    if (revocationLogoutPending) {
      await startRevocationCleanup();
    }
    if (revocationLogoutPending) {
      return false;
    }
    businessMembershipRevokedOpen.value = false;
    return true;
  }

  async function runCheckAuth(
    flightEpoch: number,
    onError?: (error: unknown) => void,
    skipMembershipProbe = false,
  ): Promise<AuthCheckResult> {
    try {
      const result = await getKimiWebApi().getAuth();
      if (flightEpoch !== epoch) return 'retry';
      managedProviderStatus.value = result.managedProvider?.status ?? null;
      authChecked.value = true;
      modelsStore().setModelsReady(result.modelsReady);
      if (managedProviderStatus.value === 'authenticated') {
        if (!skipMembershipProbe) {
          void trackMembershipFlight(++userInfoFetchGeneration);
          void reloadManagedWorkspaces();
        }
      } else {
        userInfoFetchGeneration += 1;
        workspacesFetchGeneration += 1;
        managedUserInfo.value = null;
        managedMembership.value = null;
        clearWorkspaceState();
      }
      connectIssue.value = null;
      return 'proceed';
    } catch (err) {
      if (flightEpoch !== epoch) return 'retry';
      if (
        isDaemonApiError(err) &&
        (err.code === 401 || err.code === SERVER_AUTH_UNAUTHORIZED_CODE)
      ) {
        connectIssue.value = null;
        return 'server-auth-required';
      }
      onError?.(err);
      connectIssue.value = classifyConnectIssue(err);
      return 'retry';
    }
  }

  function checkAuth(onError?: (error: unknown) => void): Promise<AuthCheckResult> {
    const flight = checkAuthFlight;
    if (flight !== null) {
      checkAuthDirty = true;
      return joinTrailingAuth(flight);
    }
    const launched = runCheckAuth(epoch, onError);
    checkAuthFlight = launched;
    return launched.finally(() => {
      if (checkAuthFlight !== launched) return;
      checkAuthFlight = null;
      if (checkAuthDirty) {
        checkAuthDirty = false;
        void checkAuth(onError);
      }
    });
  }

  async function joinTrailingAuth(flight: Promise<AuthCheckResult>): Promise<AuthCheckResult> {
    await flight.catch(() => 'retry' as AuthCheckResult);
    const trailing = checkAuthFlight;
    if (trailing === null) return checkAuth();
    return trailing;
  }

  function markAuthDirty(): void {
    if (checkAuthFlight !== null) checkAuthDirty = true;
  }

  function resetAuth(options?: { keepRevokedModal?: boolean }): void {
    epoch += 1;
    userInfoFetchGeneration += 1;
    workspacesFetchGeneration += 1;
    checkAuthFlight = null;
    checkAuthDirty = false;
    membershipFlight = null;
    switchWorkspaceFlight = null;
    managedProviderStatus.value = null;
    managedUserInfo.value = null;
    managedMembership.value = null;
    clearWorkspaceState();
    if (!options?.keepRevokedModal) {
      businessMembershipRevokedOpen.value = false;
      revocationLogoutPending = false;
    }
    authChecked.value = false;
  }

  async function logout(): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.logout();
      track('logout', {});
      resetAuth();
      await checkAuth();
      await authHooks?.reload?.();
    } catch (err) {
      warningsStore().pushOperationFailure('logout', err);
    }
  }

  return {
    managedProviderStatus,
    managedUserInfo,
    managedMembership,
    managedWorkspaces,
    managedWorkspacesLoaded,
    managedWorkspacesLoading,
    managedWorkspacesError,
    switchingWorkspaceKey,
    switchingWorkspaceName,
    recentWorkspaceKeys,
    businessMembershipRevokedOpen,
    authChecked,
    connectIssue,
    signedIn,
    isFree,
    hasBusinessWorkspace,
    currentManagedWorkspace,
    checkAuth,
    probeMembership,
    reloadManagedWorkspaces,
    switchManagedWorkspace,
    waitForWorkspaceSwitch,
    handleBusinessMembershipRevoked,
    acknowledgeBusinessMembershipRevoked,
    markAuthDirty,
    resetAuth,
    logout,
  };
});

export function authStore() {
  return useAuthStore(clientPinia);
}
