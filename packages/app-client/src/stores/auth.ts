import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ManagedUserInfo } from '@moonshot-ai/app-core/api';
import { isDaemonApiError, SERVER_AUTH_UNAUTHORIZED_CODE } from '@moonshot-ai/app-core/api';
import { classifyConnectIssue, isFreePlan, type ConnectIssue } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { track } from '../contracts';
import type { ManagedMembership } from '../client/types';
import { clientPinia } from './pinia';
import { modelsStore } from './models';
import { warningsStore } from './warnings';

export type AuthCheckResult = 'proceed' | 'retry' | 'server-auth-required';

export interface AuthHooks {
  reload: () => Promise<void>;
}

let authHooks: AuthHooks | null = null;

export function setAuthHooks(next: AuthHooks | null): void {
  authHooks = next;
}

export const useAuthStore = defineStore('kimi.auth', () => {
  const managedProviderStatus = ref<string | null>(null);
  const managedUserInfo = ref<ManagedUserInfo | null>(null);
  const managedMembership = ref<ManagedMembership>(null);
  const authChecked = ref(false);
  const connectIssue = ref<ConnectIssue | null>(null);

  const signedIn = computed(() => managedProviderStatus.value === 'authenticated');
  const isFree = computed(() => managedMembership.value === 'free');

  let checkAuthFlight: Promise<AuthCheckResult> | null = null;
  let checkAuthDirty = false;
  let epoch = 0;

  let userInfoFetchGeneration = 0;
  let membershipFlight: Promise<void> | null = null;

  async function fetchManagedProfile(generation: number): Promise<void> {
    try {
      const infoResult = await getKimiWebApi().getUserInfo();
      if (generation !== userInfoFetchGeneration) return;
      if (managedProviderStatus.value !== 'authenticated') return;
      managedUserInfo.value = infoResult.kind === 'ok' ? infoResult.userInfo : null;
      if (infoResult.kind === 'ok') {
        managedMembership.value = isFreePlan(
          infoResult.userInfo.userLevel,
          infoResult.userInfo.goodsVersion,
        )
          ? 'free'
          : 'member';
      } else {
        managedMembership.value = infoResult.status === 402 ? 'free' : null;
      }
    } catch {
      if (generation !== userInfoFetchGeneration) return;
      if (managedProviderStatus.value === 'authenticated') {
        managedUserInfo.value = null;
        managedMembership.value = null;
      }
    }
  }

  function trackMembershipFlight(generation: number): Promise<void> {
    const flight = fetchManagedProfile(generation).finally(() => {
      if (membershipFlight === flight) membershipFlight = null;
    });
    membershipFlight = flight;
    return flight;
  }

  async function probeMembership(): Promise<void> {
    if (managedProviderStatus.value !== 'authenticated') return;
    if (membershipFlight !== null) return membershipFlight;
    await trackMembershipFlight(++userInfoFetchGeneration);
  }

  async function runCheckAuth(flightEpoch: number, onError?: (error: unknown) => void): Promise<AuthCheckResult> {
    try {
      const result = await getKimiWebApi().getAuth();
      if (flightEpoch !== epoch) return 'retry';
      managedProviderStatus.value = result.managedProvider?.status ?? null;
      authChecked.value = true;
      modelsStore().setModelsReady(result.modelsReady);
      if (managedProviderStatus.value === 'authenticated') {
        void trackMembershipFlight(++userInfoFetchGeneration);
      } else {
        managedUserInfo.value = null;
        managedMembership.value = null;
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

  function resetAuth(): void {
    epoch += 1;
    checkAuthFlight = null;
    checkAuthDirty = false;
    membershipFlight = null;
    managedProviderStatus.value = null;
    managedUserInfo.value = null;
    managedMembership.value = null;
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
    authChecked,
    connectIssue,
    signedIn,
    isFree,
    checkAuth,
    probeMembership,
    markAuthDirty,
    resetAuth,
    logout,
  };
});

export function authStore() {
  return useAuthStore(clientPinia);
}
