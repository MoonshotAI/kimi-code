import { computed, nextTick, ref, watch } from 'vue';
import { useKimiWebClient } from '../client';
import type { PromptEnvelope } from '../client';
import { registerArchivedSettingsOpener } from '../client/deps';
import { workspacesStore } from '../stores/workspaces';
import { useIsMobile } from './useIsMobile';
import { registerWorktreeSettingsOpener } from './useWorktreeManageDialogs';
import { openDialogCount } from '@moonshot-ai/app-ui';
import { resolveUpgradeRegion } from '@moonshot-ai/app-core/lib';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { hostsStore } from '../stores/hosts';

export type PendingWorkspaceSubmit = {
  prompt: PromptEnvelope;
  restoreText?: string;
  editText?: string;
  restoreEntries?: AttachmentEntry[];
};

export type AppDialogsDeps = {
  restorePendingComposer: (pending: PendingWorkspaceSubmit, sessionId?: string) => void;
  onWorkspaceAdded?: () => void;
};

const showOnboarding = ref(false);
const showMobileSwitcher = ref(false);
const showMobileSettings = ref(false);
const showModelPicker = ref(false);
const showLogin = ref(false);
const showAddWorkspace = ref(false);
const showStatusPanel = ref(false);
const showSettings = ref(false);
const authRequired = ref(false);

export type SettingsHighlightKey = 'running-send-mode';

const settingsInitialTab = ref<'providers' | 'archived' | 'agent' | 'hosts' | 'worktrees' | undefined>(undefined);
const mobileSettingsInitialTab = ref<'providers' | undefined>(undefined);
const settingsHighlightKey = ref<SettingsHighlightKey | undefined>(undefined);
const modelPickerTargetSid = ref<string | undefined>(undefined);
const modelsLoading = ref(false);
const modelsUnavailable = ref(false);
const configSaving = ref(false);
const addWorkspaceError = ref<string | null>(null);
const pendingWorkspaceSubmit = ref<PendingWorkspaceSubmit | null>(null);

watch(showMobileSettings, (open) => {
  if (!open) mobileSettingsInitialTab.value = undefined;
});

watch([showSettings, showMobileSettings], ([settingsOpen, mobileOpen]) => {
  if (!settingsOpen && !mobileOpen) {
    settingsHighlightKey.value = undefined;
    hostsStore().requestFocus(null);
  }
});

const anyOverlayOpen = computed<boolean>(
  () =>
    openDialogCount.value > 0 ||
    showModelPicker.value ||
    showLogin.value ||
    showAddWorkspace.value ||
    showStatusPanel.value ||
    showSettings.value ||
    showOnboarding.value ||
    showMobileSwitcher.value ||
    showMobileSettings.value,
);

let deps: AppDialogsDeps | null = null;
let stateInitialized = false;
let dialogOpenSeq = 0;

export function openAgentSettings(mobile = false): void {
  const seq = ++dialogOpenSeq;
  showModelPicker.value = false;
  if (mobile) {
    showSettings.value = false;
    mobileSettingsInitialTab.value = undefined;
    if (showMobileSettings.value) {
      showMobileSettings.value = false;
      void nextTick(() => {
        if (seq !== dialogOpenSeq) return;
        settingsHighlightKey.value = 'running-send-mode';
        showMobileSettings.value = true;
      });
    } else {
      settingsHighlightKey.value = 'running-send-mode';
      showMobileSettings.value = true;
    }
  } else {
    showMobileSettings.value = false;
    if (showSettings.value) {
      showSettings.value = false;
      void nextTick(() => {
        if (seq !== dialogOpenSeq) return;
        settingsInitialTab.value = 'agent';
        settingsHighlightKey.value = 'running-send-mode';
        showSettings.value = true;
      });
    } else {
      settingsInitialTab.value = 'agent';
      settingsHighlightKey.value = 'running-send-mode';
      showSettings.value = true;
    }
  }
}

function openWorktreeSettingsTab(): void {
  const seq = ++dialogOpenSeq;
  showModelPicker.value = false;
  showMobileSettings.value = false;
  settingsHighlightKey.value = undefined;
  settingsInitialTab.value = 'worktrees';
  if (!showSettings.value) {
    showSettings.value = true;
    return;
  }
  showSettings.value = false;
  void nextTick(() => {
    if (seq !== dialogOpenSeq) return;
    settingsInitialTab.value = 'worktrees';
    showSettings.value = true;
  });
}

registerWorktreeSettingsOpener(openWorktreeSettingsTab);

export function openHostSettings(hostId?: string, options?: { addIfEmpty?: boolean }): void {
  const seq = ++dialogOpenSeq;
  showModelPicker.value = false;
  showMobileSettings.value = false;
  settingsHighlightKey.value = undefined;
  hostsStore().requestFocus(hostId ?? null, options);
  settingsInitialTab.value = 'hosts';
  if (showSettings.value) {
    showSettings.value = false;
    void nextTick(() => {
      if (seq !== dialogOpenSeq) return;
      hostsStore().requestFocus(hostId ?? null, options);
      settingsInitialTab.value = 'hosts';
      showSettings.value = true;
    });
  } else {
    showSettings.value = true;
  }
}

export function useAppDialogs(dialogDeps?: AppDialogsDeps) {
  const client = useKimiWebClient();
  const isMobile = useIsMobile();
  if (!stateInitialized) {
    stateInitialized = true;
    showOnboarding.value = client.onboarded?.value === false;
  }
  if (dialogDeps !== undefined) deps = dialogDeps;

  const showServerAuth = computed(
    () => client.dangerousBypassAuth?.value !== true && authRequired.value,
  );

  function completeOnboarding(): void {
    client.setOnboarded(true);
    showOnboarding.value = false;
  }

  function handleWizardAddProvider(): void {
    ++dialogOpenSeq;
    completeOnboarding();
    settingsHighlightKey.value = undefined;
    settingsInitialTab.value = 'providers';
    showSettings.value = true;
  }

  async function openModelPicker(targetSid?: string): Promise<void> {
    modelPickerTargetSid.value = targetSid;
    modelsLoading.value = true;
    modelsUnavailable.value = false;
    showModelPicker.value = true;
    try {
      await client.refreshAllProviders();
    } catch {
      modelsUnavailable.value = true;
    } finally {
      modelsLoading.value = false;
    }
  }

  function openLogin(): void {
    showLogin.value = true;
  }

  function openAddWorkspace(): void {
    showAddWorkspace.value = true;
  }

  function openProviderSettings(): void {
    const seq = ++dialogOpenSeq;
    showModelPicker.value = false;
    settingsHighlightKey.value = undefined;
    if (isMobile.value) {
      showSettings.value = false;
      mobileSettingsInitialTab.value = 'providers';
      showMobileSettings.value = true;
    } else {
      showMobileSettings.value = false;
      settingsInitialTab.value = 'providers';
      if (showSettings.value) {
        showSettings.value = false;
        void nextTick(() => {
          if (seq !== dialogOpenSeq) return;
          showSettings.value = true;
        });
      } else {
        showSettings.value = true;
      }
    }
  }

  function openArchivedSettings(): void {
    ++dialogOpenSeq;
    settingsHighlightKey.value = undefined;
    settingsInitialTab.value = 'archived';
    showSettings.value = true;
  }

  registerArchivedSettingsOpener(openArchivedSettings);

  function dropPendingWorkspaceSubmit(): void {
    const pending = pendingWorkspaceSubmit.value;
    pendingWorkspaceSubmit.value = null;
    if (pending) deps?.restorePendingComposer(pending);
  }

  async function completeWorkspaceCreation(): Promise<boolean> {
    deps?.onWorkspaceAdded?.();
    showAddWorkspace.value = false;
    const pending = pendingWorkspaceSubmit.value;
    pendingWorkspaceSubmit.value = null;
    const wsId = client.activeWorkspaceId.value;
    if (pending && wsId) {
      await client.ensureWorkspaceTrust(wsId, { background: false });
      if (client.activeSessionId.value !== null || client.activeWorkspaceId.value !== wsId || client.activeWorkspaceTrust.value !== true) {
        deps?.restorePendingComposer(pending);
        return true;
      }
      const started = await client.startSessionAndSendPrompt(wsId, pending.prompt);
      if (started.promptRejected || (started.sessionId === null && started.concurrent !== true)) {
        deps?.restorePendingComposer(pending, started.sessionId ?? undefined);
      }
    }
    return true;
  }

  async function addWorkspace(root: string): Promise<boolean> {
    addWorkspaceError.value = null;
    const added = await client.addWorkspaceByPath(root);
    if (!added) return workspacesStore().takeAddWorkspaceCancelled();
    return completeWorkspaceCreation();
  }

  function handleCloseAddWorkspace(): void {
    dropPendingWorkspaceSubmit();
    addWorkspaceError.value = null;
    showAddWorkspace.value = false;
  }

  async function handleLoginSuccess(): Promise<void> {
    showLogin.value = false;
    await client.checkAuth();
    await client.load();
    void resolveUpgradeRegion(() => client.getOAuthRegion());
  }

  return {
    showOnboarding,
    showMobileSwitcher,
    showMobileSettings,
    showModelPicker,
    showLogin,
    showAddWorkspace,
    showStatusPanel,
    showSettings,
    authRequired,
    showServerAuth,
    settingsInitialTab,
    mobileSettingsInitialTab,
    settingsHighlightKey,
    modelPickerTargetSid,
    modelsLoading,
    modelsUnavailable,
    configSaving,
    addWorkspaceError,
    pendingWorkspaceSubmit,
    anyOverlayOpen,
    completeOnboarding,
    handleWizardAddProvider,
    openModelPicker,
    openLogin,
    openAddWorkspace,
    openProviderSettings,
    openArchivedSettings,
    openHostSettings,
    openAgentSettings: () => openAgentSettings(isMobile.value),
    dropPendingWorkspaceSubmit,
    completeWorkspaceCreation,
    addWorkspace,
    handleCloseAddWorkspace,
    handleLoginSuccess,
  };
}
