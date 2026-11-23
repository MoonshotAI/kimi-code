<script setup lang="ts">
import { v4 as randomUUID } from 'uuid';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppHost, AppHostConnectFailure, AppHostDefinition, AppSshConfigHost, AppSshConfigHosts } from '@moonshot-ai/app-core/api';
import { hostDisplayName, hostDisplayState, providerDisplayName } from '@moonshot-ai/app-core/lib';
import { isImeKeyEvent } from '@moonshot-ai/app-client/lib';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { hostDefinition, hostsStore, type HostAccount, type HostProviderCopy } from '@moonshot-ai/app-client/stores';
import { Banner, Button, Field, Icon, IconButton, Input, Menu, MenuItem, SegmentedControl, StatusDot, Switch } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';
import { useHostFailureText } from '../composables/useHostFailureText';
import HostTestResult from './HostTestResult.vue';

const props = defineProps<{
  openSshConfig?: (path: string) => void;
  pickIdentityFile?: (defaultPath?: string) => Promise<string | undefined>;
  createProject?: (hostId: string) => void;
}>();

const { locale, t } = useI18n();
const store = hostsStore();
const { confirm } = useConfirmDialog();
const failureText = useHostFailureText();
const rootEl = ref<HTMLElement>();
const pageMode = ref<'list' | 'add' | 'edit'>('list');
const addTab = ref<'config' | 'manual'>('config');
const originalId = ref('');
const name = ref('');
const host = ref('');
const identityFile = ref('');
const remoteBin = ref('');
const advancedOpen = ref(false);
const openDetailId = ref('');
const copyFeedbackId = ref('');
const busy = ref(false);
const testing = ref(false);
const error = ref('');
const testFailure = ref<{ failure?: AppHostConnectFailure; reason: string; hint: string; detail: string }>();
const pendingIds = ref<Record<string, boolean>>({});
const flashId = ref('');
const backButton = ref<HTMLButtonElement>();
const nameInput = ref<InstanceType<typeof Input>>();
const loadFailed = ref(false);
const sshHosts = ref<AppSshConfigHosts | null>(null);
const sshHostsLoading = ref(false);
const sshHostsFailed = ref(false);
const addingHost = ref('');
const targetTouched = ref(false);
const rowMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const rowMenuId = ref('');
const { open: rowMenuOpen, menuStyle: rowMenuStyle, showAnchored: showRowMenu, close: closeRowMenu } = useAnchoredMenu(rowMenuRef);
let flashTimer = 0;
let copyFeedbackTimer = 0;
let testAbort: AbortController | undefined;

const original = computed(() => store.hosts.find((row) => row.id === originalId.value));
const menuRow = computed(() => store.hosts.find((row) => row.id === rowMenuId.value));
const testState = computed(() => (testing.value ? 'running' : testFailure.value ? 'failed' : undefined));
const nameError = computed(() => {
  const value = name.value.trim();
  if (value === '') return t('settings.hosts.nameRequired');
  if (value.length > 64) return t('settings.hosts.nameTooLong');
  if (store.hosts.some((row) => hostDisplayName(row) === value && row.id !== originalId.value)) return t('settings.hosts.nameDuplicate');
  return '';
});
const targetError = computed(() => host.value.trim() === '' ? t('settings.hosts.targetRequired') : '');
const canSubmit = computed(() => nameError.value === '' && targetError.value === '' && !busy.value);
const configuredHosts = computed(() => new Set(store.hosts.map((row) => row.host)));
const detectedHosts = computed(() => (sshHosts.value?.hosts ?? []).filter((entry) => !configuredHosts.value.has(entry.alias)));
const subpage = computed(() => pageMode.value !== 'list');
const hasSourceTabs = computed(() => pageMode.value === 'add');
const showForm = computed(() => pageMode.value === 'edit' || (pageMode.value === 'add' && addTab.value === 'manual'));
const showHostPicker = computed(() => pageMode.value === 'add' && addTab.value === 'config');
const addSourceOptions = computed(() => [
  { value: 'config', label: t('settings.hosts.sshHostsTitle') },
  { value: 'manual', label: t('settings.hosts.addManually') },
]);
const writeBlocked = computed(() => busy.value || testing.value || addingHost.value !== '');

onUnmounted(() => {
  window.clearTimeout(flashTimer);
  window.clearTimeout(copyFeedbackTimer);
  testAbort?.abort();
});

function enabled(row: AppHost): boolean {
  return row.enabled !== false;
}

function connectionState(row: AppHost) {
  return hostDisplayState(row.id, row, {
    loaded: true,
    connecting: pendingIds.value[row.id] === true || store.connecting[row.id] === true,
  });
}

function retrying(row: AppHost): boolean {
  return connectionState(row) === 'connecting' && (row.connectError !== undefined || row.connectFailure !== undefined);
}

function statusLabel(row: AppHost): string {
  return t(`workspace.hostState.${retrying(row) ? 'retrying' : connectionState(row)}`);
}

function showsFailure(row: AppHost): boolean {
  return connectionState(row) === 'failed' || retrying(row);
}

function isExpandable(row: AppHost): boolean {
  if (showsFailure(row)) return true;
  const notice = rowNotice(row);
  return notice === 'needsModels' || notice === 'copyFailed';
}

function failureOpen(row: AppHost): boolean {
  return openDetailId.value === row.id && showsFailure(row);
}

function toggleDetail(id: string): void {
  openDetailId.value = openDetailId.value === id ? '' : id;
}

function onRowLeadClick(row: AppHost): void {
  if (isExpandable(row)) toggleDetail(row.id);
}

function rowFailureSummary(row: AppHost): string {
  return failureText.label(row.connectFailure, row.remoteVersion)
    || (row.connectError ?? '').split('\n', 1)[0]?.trim()
    || t('settings.hosts.showDetails');
}

function copyFeedback(row: AppHost): HostProviderCopy | undefined {
  return copyFeedbackId.value === row.id && connectionState(row) === 'ready' ? store.providerCopies[row.id] : undefined;
}

function rowNotice(row: AppHost): 'needsModels' | 'copyFailed' | 'copying' | 'copied' | undefined {
  if (connectionState(row) === 'ready' && store.needsLogin(row.id)) return 'needsModels';
  const status = copyFeedback(row)?.status;
  if (status === 'failed') return 'copyFailed';
  if (status === 'copying') return 'copying';
  if (status === 'done') return 'copied';
  return undefined;
}

function noticeOpen(row: AppHost): boolean {
  const notice = rowNotice(row);
  return openDetailId.value === row.id && (notice === 'needsModels' || notice === 'copyFailed');
}

function noticeText(row: AppHost): string {
  const notice = rowNotice(row);
  if (notice === 'needsModels') return t('settings.hosts.setupNeeded');
  if (notice === 'copyFailed') return t('settings.hosts.copyFailedStatus');
  if (notice === 'copying') return t('settings.hosts.copyingStatus');
  const copy = copyFeedback(row);
  if (copy?.status !== 'done') return '';
  const names = copy.result.providers.map((id) => providerDisplayName(id, t));
  return names.length === 0
    ? t('settings.hosts.localNone')
    : t('settings.hosts.localCopied', { names: new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(names) });
}

function setupText(row: AppHost): string {
  const copy = copyFeedback(row);
  if (copy?.status === 'failed') return t('settings.hosts.localFailed');
  if (copy?.status === 'done' && copy.result.providers.length === 0) return t('settings.hosts.localNone');
  return t('settings.hosts.setupHint');
}

watch(() => (copyFeedbackId.value === '' ? undefined : store.providerCopies[copyFeedbackId.value]?.status), (status) => {
  window.clearTimeout(copyFeedbackTimer);
  if (status !== 'done') return;
  const hostId = copyFeedbackId.value;
  copyFeedbackTimer = window.setTimeout(() => {
    if (copyFeedbackId.value === hostId) copyFeedbackId.value = '';
  }, 4000);
});

function dotFor(row: AppHost): string {
  const state = connectionState(row);
  if (state === 'ready') return 'ok';
  if (state === 'connecting') return 'running';
  if (state === 'failed') return 'error';
  return 'idle';
}

function clearResult(): void {
  error.value = '';
  testFailure.value = undefined;
}

function cancelTest(): void {
  testAbort?.abort();
  testAbort = undefined;
  testing.value = false;
  clearResult();
}

function flashRow(hostId: string): void {
  flashId.value = hostId;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashId.value = '';
  }, 1200);
}

function applyFocusHost(): void {
  const targetId = store.focusHostId;
  const openAdd = store.addIfEmpty;
  if (!targetId && !openAdd) return;
  if (!store.loaded) return;
  const row = targetId ? store.hostFor(targetId) : undefined;
  store.requestFocus(null);
  cancelTest();
  fillForm(undefined);
  pageMode.value = 'list';
  if (openAdd && store.hosts.length === 0) {
    void startAdd();
    return;
  }
  if (!row) return;
  if (isExpandable(row)) openDetailId.value = row.id;
  flashRow(row.id);
  void nextTick(() => {
    const el = [...(rootEl.value?.querySelectorAll<HTMLElement>('[data-host-id]') ?? [])]
      .find((item) => item.dataset.hostId === row.id);
    el?.scrollIntoView?.({ block: 'nearest' });
  });
}

watch(() => [store.focusHostId, store.addIfEmpty, store.loaded] as const, applyFocusHost, { immediate: true });

async function loadHosts(): Promise<void> {
  if (sshHostsLoading.value) return;
  sshHostsLoading.value = true;
  sshHostsFailed.value = false;
  try {
    sshHosts.value = await store.loadSshConfig();
  } catch {
    sshHostsFailed.value = true;
  } finally {
    sshHostsLoading.value = false;
  }
}

function hostTarget(entry: AppSshConfigHost): string {
  const hostName = entry.hostName ?? entry.alias;
  const withUser = entry.user === undefined ? hostName : `${entry.user}@${hostName}`;
  return entry.port === undefined ? withUser : `${withUser}:${entry.port}`;
}

function availableName(alias: string): string {
  const base = alias.slice(0, 64);
  const taken = new Set(store.hosts.map(hostDisplayName));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base.slice(0, 60)}-${suffix}`)) suffix++;
  return `${base.slice(0, 60)}-${suffix}`;
}

async function toggleRowMenu(row: AppHost, event: MouseEvent): Promise<void> {
  if (rowMenuOpen.value && rowMenuId.value === row.id) {
    closeRowMenu();
    return;
  }
  if (connectionState(row) === 'ready' && store.accounts[row.id] === undefined) {
    void store.loadAccount(row.id);
  }
  rowMenuId.value = row.id;
  await showRowMenu(event, 'right');
}

async function browseIdentityFile(): Promise<void> {
  if (props.pickIdentityFile === undefined) return;
  const configPath = sshHosts.value?.configPath;
  const picked = await props.pickIdentityFile(configPath === undefined ? undefined : configPath.replace(/[\\/][^\\/]+$/, ''));
  if (picked === undefined) return;
  identityFile.value = picked;
  clearResult();
}

function fillForm(row: AppHost | undefined): void {
  originalId.value = row?.id ?? '';
  name.value = row === undefined ? '' : hostDisplayName(row);
  host.value = row?.host ?? '';
  identityFile.value = row?.identityFile ?? '';
  remoteBin.value = row?.remoteBin ?? '';
  advancedOpen.value = remoteBin.value !== '';
  targetTouched.value = false;
  clearResult();
}

function openAddPage(): void {
  if (detectedHosts.value.length > 0) {
    addTab.value = 'config';
    void nextTick(() => backButton.value?.focus({ preventScroll: true }));
    return;
  }
  addTab.value = 'manual';
  void nextTick(() => nameInput.value?.focus());
}

async function startAdd(): Promise<void> {
  store.takeAddIfEmpty();
  closeRowMenu();
  fillForm(undefined);
  pageMode.value = 'add';
  if (sshHosts.value === null) await loadHosts();
  openAddPage();
}

function setAddSource(source: string): void {
  const next = source === 'manual' ? 'manual' : 'config';
  if (addTab.value === next) return;
  if (next === 'config') cancelTest();
  addTab.value = next;
  clearResult();
  if (next === 'manual') void nextTick(() => nameInput.value?.focus());
}

function startEdit(row: AppHost): void {
  closeRowMenu();
  fillForm(row);
  pageMode.value = 'edit';
  void nextTick(() => nameInput.value?.focus());
}

function back(): void {
  cancelTest();
  fillForm(undefined);
  pageMode.value = 'list';
}

function cancel(): void {
  if (testing.value) cancelTest();
  else back();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event) || busy.value) return;
  if (!subpage.value && !testing.value) return;
  event.preventDefault();
  cancel();
}

function draftDefinition(): AppHostDefinition {
  const displayName = name.value.trim();
  const target = host.value.trim();
  const unnamed = original.value !== undefined && original.value.name === undefined && displayName === original.value.id;
  return {
    host: /^[^\s:/]+:\d+$/.test(target) ? `ssh://${target}` : target,
    identityFile: identityFile.value.trim() || undefined,
    remoteBin: remoteBin.value.trim() || undefined,
    name: unnamed ? undefined : displayName,
    enabled: original.value?.enabled === false ? false : undefined,
  };
}

function connectionKey(value: AppHostDefinition): string {
  return JSON.stringify([value.host, value.identityFile, value.remoteBin]);
}

async function test(): Promise<boolean> {
  const controller = new AbortController();
  testAbort = controller;
  testing.value = true;
  clearResult();
  try {
    const result = await store.test(draftDefinition(), controller.signal);
    if (controller.signal.aborted) return false;
    if (result.connected) return true;
    testFailure.value = {
      failure: result.connectFailure,
      reason: failureText.label(result.connectFailure, result.remoteVersion),
      hint: failureText.hint(result.connectFailure, draftDefinition().host, name.value.trim()),
      detail: result.connectError ?? '',
    };
    return false;
  } catch (cause) {
    if (controller.signal.aborted) return false;
    testFailure.value = { reason: '', hint: '', detail: cause instanceof Error ? cause.message : String(cause) };
    return false;
  } finally {
    if (testAbort === controller) {
      testAbort = undefined;
      testing.value = false;
    }
  }
}

function newHostId(): string {
  let hostId: string;
  do hostId = `host-${randomUUID().slice(0, 8)}`;
  while (store.hosts.some((row) => row.id === hostId));
  return hostId;
}

async function writeHost(existingId: string, saved: AppHostDefinition, expandOnFailure = false): Promise<string | undefined> {
  busy.value = true;
  clearResult();
  try {
    const hostId = existingId || newHostId();
    try {
      await store.save(hostId, saved);
    } catch {
      error.value = t('settings.hosts.saveFailed');
      return undefined;
    }
    back();
    flashRow(hostId);
    const savedRow = store.hostFor(hostId);
    if (expandOnFailure && savedRow && connectionState(savedRow) === 'failed') {
      openDetailId.value = hostId;
    }
    if (saved.enabled !== false) void reconnect(hostId, expandOnFailure);
    return hostId;
  } finally {
    busy.value = false;
  }
}

async function save(): Promise<void> {
  targetTouched.value = true;
  if (!canSubmit.value || testing.value) return;
  const saved = draftDefinition();
  const before = original.value;
  const needsTest = saved.enabled !== false && (before === undefined || connectionKey(saved) !== connectionKey(before));
  if (needsTest && !await test()) return;
  await writeHost(originalId.value, saved);
}

async function saveAnyway(): Promise<void> {
  if (!canSubmit.value || testing.value) return;
  await writeHost(originalId.value, draftDefinition(), true);
}

async function addHost(entry: AppSshConfigHost): Promise<void> {
  if (writeBlocked.value) return;
  addingHost.value = entry.alias;
  try {
    await writeHost('', { name: availableName(entry.alias), host: entry.alias }, true);
  } finally {
    addingHost.value = '';
  }
}

async function setEnabled(row: AppHost, value: boolean): Promise<void> {
  if (pendingIds.value[row.id] || busy.value || value === enabled(row)) return;
  error.value = '';
  pendingIds.value = { ...pendingIds.value, [row.id]: true };
  try {
    await store.save(row.id, { ...hostDefinition(row), enabled: value ? undefined : false });
  } catch {
    error.value = t('settings.hosts.saveFailed');
    return;
  } finally {
    const next = { ...pendingIds.value };
    delete next[row.id];
    pendingIds.value = next;
  }
  if (value) void reconnect(row.id);
}

function copyRow(hostId: string): void {
  copyFeedbackId.value = hostId;
  void store.copyProviders(hostId);
}

async function copyToRow(row: AppHost): Promise<void> {
  closeRowMenu();
  if (await failureText.confirmCopy(hostDisplayName(row))) copyRow(row.id);
}

async function reconnect(hostId: string, expandOnFailure = false): Promise<void> {
  closeRowMenu();
  try {
    await store.connect(hostId);
  } catch {
    await reload();
  }
  if (expandOnFailure) {
    const row = store.hostFor(hostId);
    if (row && connectionState(row) === 'failed') openDetailId.value = hostId;
  }
}

function account(row: AppHost): HostAccount | undefined {
  return connectionState(row) === 'ready' ? store.accounts[row.id] : undefined;
}

function signOutLabel(): string {
  return t('settings.hosts.kimiSignOut');
}

async function signOutRow(hostId: string): Promise<void> {
  closeRowMenu();
  error.value = '';
  try {
    await store.signOut(hostId);
  } catch {
    error.value = t('settings.hosts.signOutFailed');
  }
}

async function remove(row: AppHost): Promise<void> {
  closeRowMenu();
  if (busy.value) return;
  const ok = await confirm({
    title: t('settings.hosts.deleteTitle'),
    message: t('settings.hosts.deleteMessage', { name: hostDisplayName(row) }),
    confirmLabel: t('settings.hosts.delete'),
    variant: 'danger',
  });
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await store.remove(row.id);
    back();
  } catch {
    error.value = t('settings.hosts.deleteFailed');
  } finally {
    busy.value = false;
  }
}

async function reload(): Promise<void> {
  loadFailed.value = false;
  try {
    await store.load();
  } catch {
    loadFailed.value = true;
  }
}

void reload();
void loadHosts();
</script>

<template>
  <section ref="rootEl" :class="subpage ? 're-page' : 're'" @keydown="onKeydown">
    <div v-if="subpage" class="re-page-head">
      <button ref="backButton" type="button" class="re-back" :aria-label="t('settings.hosts.back')" @click="back">
        <Icon name="arrow-left" size="sm" />
      </button>
      <span class="re-page-title">{{ pageMode === 'edit' && original ? hostDisplayName(original) : t('settings.hosts.add') }}</span>
    </div>
    <div v-else class="re-head">
      <div class="re-head-copy">
        <h3 class="sec-title">{{ t('settings.hosts.title') }}</h3>
      </div>
      <Button variant="secondary" size="sm" :disabled="busy" @click="startAdd">
        <Icon name="plus" size="sm" />{{ t('settings.hosts.add') }}
      </Button>
    </div>

    <div v-if="hasSourceTabs" class="re-hosts-head">
      <SegmentedControl
        size="sm"
        :model-value="addTab"
        :options="addSourceOptions"
        :disabled="busy"
        @update:model-value="setAddSource"
      />
      <div v-if="showHostPicker" class="re-hosts-actions">
        <IconButton v-if="openSshConfig && sshHosts?.exists" class="re-hosts-open" size="sm" :label="t('settings.hosts.openSshConfig')" :tooltip="t('settings.hosts.openSshConfig')" @click="openSshConfig(sshHosts.configPath)">
          <Icon name="external-link" size="sm" />
        </IconButton>
        <IconButton class="re-hosts-refresh" size="sm" :label="t('settings.hosts.sshHostsRefresh')" :tooltip="t('settings.hosts.sshHostsRefresh')" :disabled="sshHostsLoading" @click="loadHosts">
          <Icon name="refresh" size="sm" />
        </IconButton>
      </div>
    </div>

    <template v-if="showForm">
      <p class="re-page-hint">{{ t('settings.hosts.formHint') }}</p>

      <Field :label="t('settings.hosts.nameLabel')" :error="name !== '' ? nameError : ''">
        <Input ref="nameInput" v-model="name" size="sm" :placeholder="t('settings.hosts.namePlaceholder')" :disabled="busy || testing" :error="name !== '' && nameError !== ''" autocomplete="off" spellcheck="false" @update:model-value="clearResult" />
      </Field>
      <Field :label="t('settings.hosts.targetLabel')" :error="targetTouched ? targetError : ''" :hint="t('settings.hosts.targetHint')">
        <Input v-model="host" size="sm" :placeholder="t('settings.hosts.targetPlaceholder')" :disabled="busy || testing" :error="targetTouched && targetError !== ''" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="targetTouched = true; clearResult()" />
      </Field>
      <Field :label="t('settings.hosts.identityLabel')" :hint="t('settings.hosts.identityHint')">
        <div class="re-input-row">
          <Input v-model="identityFile" size="sm" placeholder="~/.ssh/id_ed25519" :disabled="busy || testing" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="clearResult" />
          <Button v-if="pickIdentityFile" class="re-browse" variant="secondary" size="sm" :disabled="busy || testing" @click="browseIdentityFile">{{ t('settings.hosts.identityBrowse') }}</Button>
        </div>
      </Field>

      <div class="re-advanced">
        <button type="button" class="re-advanced-toggle" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
          <Icon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" size="sm" />{{ t('settings.hosts.advanced') }}
        </button>
        <div v-if="advancedOpen" class="re-advanced-body">
          <Field :label="t('settings.hosts.binLabel')" :hint="t('settings.hosts.binHint')">
            <Input v-model="remoteBin" size="sm" placeholder="~/.kimi-code/bin/kimi" :disabled="busy || testing" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="clearResult" />
          </Field>
        </div>
      </div>

      <div class="re-foot" :class="{ 're-foot--result': testState }">
        <HostTestResult
          v-if="testState"
          :state="testState"
          :endpoint="draftDefinition().host"
          :failure="testFailure?.failure"
          :reason="testFailure?.reason"
          :hint="testFailure?.hint"
          :detail="testFailure?.detail"
        />
        <Banner v-if="error" variant="danger" role="alert">{{ error }}</Banner>
        <div class="re-foot-actions">
          <Button v-if="pageMode === 'edit' && original" variant="danger" size="sm" :disabled="busy || testing" @click="remove(original)">{{ t('settings.hosts.delete') }}</Button>
          <span class="re-spacer" />
          <Button variant="secondary" size="sm" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</Button>
          <Button v-if="testState === 'failed'" class="re-save-anyway" variant="secondary" size="sm" :disabled="!canSubmit" @click="saveAnyway">{{ t('settings.hosts.saveAnyway') }}</Button>
          <Button class="re-save" variant="primary" size="sm" :loading="busy || testing" :disabled="!canSubmit || testing" @click="save">{{ t(testState === 'failed' ? 'settings.hosts.retry' : 'settings.hosts.save') }}</Button>
        </div>
      </div>
    </template>

    <section v-else-if="showHostPicker" class="re-hosts" :aria-label="t('settings.hosts.sshHostsTitle')">
      <p v-if="sshHostsFailed" class="re-hosts-note">{{ t('settings.hosts.sshHostsFailed') }}</p>
      <div v-else-if="detectedHosts.length > 0" class="settings-group re-hosts-list" role="list">
        <div v-for="entry in detectedHosts" :key="entry.alias" class="re-row re-host" role="listitem">
          <span class="re-row-copy">
            <span class="re-row-name">{{ entry.alias }}</span>
            <span v-if="hostTarget(entry) !== entry.alias" class="re-host-target" :title="hostTarget(entry)">{{ hostTarget(entry) }}</span>
          </span>
          <Button class="re-host-add" variant="secondary" size="xs" :loading="addingHost === entry.alias" :disabled="writeBlocked" @click="addHost(entry)">{{ t('settings.hosts.addHost') }}</Button>
        </div>
      </div>
      <p v-else-if="sshHosts && !sshHosts.exists" class="re-hosts-note">{{ t('settings.hosts.sshHostsMissing') }}</p>
      <p v-else-if="sshHosts && sshHosts.hosts.length === 0" class="re-hosts-note">{{ t('settings.hosts.sshHostsEmpty') }}</p>
      <p v-else-if="sshHosts" class="re-hosts-note">{{ t('settings.hosts.sshHostsAllAdded') }}</p>
      <Banner v-if="error" variant="danger" role="alert">{{ error }}</Banner>
    </section>

    <template v-else>
      <div class="settings-group" role="list" :aria-label="t('settings.hosts.title')">
        <div v-if="store.hosts.length === 0" class="re-empty">
          <div class="re-empty-title">{{ t('settings.hosts.emptyTitle') }}</div>
          <div class="re-empty-hint">{{ t('settings.hosts.emptyHint') }}</div>
        </div>
        <div v-for="row in store.hosts" :key="row.id" class="re-item" :data-host-id="row.id" role="listitem">
          <div class="re-row" :class="{ disabled: !enabled(row), flash: flashId === row.id }">
            <div class="re-row-lead" :class="{ expandable: isExpandable(row) }" @click="onRowLeadClick(row)">
              <span class="re-row-copy">
                <span class="re-row-name">{{ hostDisplayName(row) }}</span>
                <span class="re-row-status" :class="`re-row-status--${connectionState(row)}`">
                  <StatusDot v-if="enabled(row)" :status="dotFor(row)" />
                  <span class="re-row-state">{{ statusLabel(row) }}</span>
                  <button
                    v-if="showsFailure(row)"
                    type="button"
                    class="re-row-detail re-row-error re-row-details"
                    :title="row.connectError ?? ''"
                    :aria-expanded="failureOpen(row)"
                    @click.stop="toggleDetail(row.id)"
                  >
                    <span class="re-row-details-text">{{ rowFailureSummary(row) }}</span>
                    <Icon :name="failureOpen(row) ? 'chevron-down' : 'chevron-right'" size="sm" />
                  </button>
                  <button
                    v-else-if="rowNotice(row) === 'needsModels' || rowNotice(row) === 'copyFailed'"
                    type="button"
                    class="re-row-detail re-row-warning re-row-details"
                    :aria-expanded="noticeOpen(row)"
                    @click.stop="toggleDetail(row.id)"
                  >
                    <span class="re-row-details-text">{{ noticeText(row) }}</span>
                    <Icon :name="noticeOpen(row) ? 'chevron-down' : 'chevron-right'" size="sm" />
                  </button>
                  <span v-else-if="rowNotice(row)" class="re-row-detail re-row-notice" :title="noticeText(row)">{{ noticeText(row) }}</span>
                  <span v-else class="re-row-detail" :title="row.host">{{ row.host }}</span>
                </span>
              </span>
            </div>
            <Switch
              :model-value="enabled(row)"
              :label="t('settings.hosts.enabledLabel', { name: hostDisplayName(row) })"
              :disabled="pendingIds[row.id] === true || busy"
              @update:model-value="setEnabled(row, $event)"
            />
            <span class="re-row-actions">
              <IconButton
                v-if="createProject"
                class="re-row-create-project"
                size="sm"
                :disabled="connectionState(row) !== 'ready'"
                :label="t(connectionState(row) === 'ready' ? 'sidebar.newWorkspace' : 'sidebar.newWorkspaceNeedsConnection')"
                :tooltip="t(connectionState(row) === 'ready' ? 'sidebar.newWorkspace' : 'sidebar.newWorkspaceNeedsConnection')"
                @click="createProject(row.id)"
              >
                <Icon name="folder-plus" />
              </IconButton>
              <IconButton
                class="re-row-more"
                :class="{ open: rowMenuOpen && rowMenuId === row.id }"
                size="sm"
                :label="t('settings.hosts.options')"
                :tooltip="t('settings.hosts.options')"
                aria-haspopup="menu"
                :aria-expanded="rowMenuOpen && rowMenuId === row.id"
                @click.stop="toggleRowMenu(row, $event)"
              >
                <Icon name="dots-horizontal" />
              </IconButton>
            </span>
          </div>
          <div v-if="failureOpen(row)" class="re-row-failure">
            <HostTestResult
              state="failed"
              :endpoint="row.host"
              :failure="row.connectFailure"
              :hint="failureText.hint(row.connectFailure, row.host, hostDisplayName(row))"
              :detail="row.connectError ?? ''"
            />
            <div class="re-row-failure-actions">
              <Button class="re-row-action re-row-reconnect" variant="secondary" size="xs" :loading="retrying(row)" @click="reconnect(row.id)">{{ t('settings.hosts.reconnect') }}</Button>
              <Button class="re-row-edit" variant="secondary" size="xs" @click="startEdit(row)">{{ t('settings.hosts.edit') }}</Button>
            </div>
          </div>
          <div v-if="noticeOpen(row) && rowNotice(row) === 'needsModels'" class="re-row-setup">
            <p class="re-row-setup-text" :class="{ 're-row-setup-text--danger': copyFeedback(row)?.status === 'failed' }">{{ setupText(row) }}</p>
            <div class="re-row-setup-actions">
              <Button class="re-row-sign-in" variant="primary" size="xs" @click="store.openLogin(row.id)">{{ t('workspace.hostNotice.signIn') }}</Button>
              <Button class="re-row-copy-local" variant="secondary" size="xs" :loading="store.providerCopies[row.id]?.status === 'copying'" @click="copyToRow(row)">{{ t('workspace.hostNotice.useLocal') }}</Button>
            </div>
          </div>
          <div v-else-if="noticeOpen(row)" class="re-row-setup">
            <Button class="re-row-copy-retry" variant="secondary" size="xs" @click="copyRow(row.id)">{{ t('settings.hosts.retry') }}</Button>
          </div>
        </div>
      </div>

      <Banner v-if="error" variant="danger" role="alert">{{ error }}</Banner>
      <Banner v-if="loadFailed" variant="warning">{{ t('settings.hosts.statusFailed') }}</Banner>

      <Transition name="ui-menu-pop">
        <Menu v-if="rowMenuOpen && menuRow" ref="rowMenuRef" class="ui-menu-floating re-row-menu" :style="rowMenuStyle" @click.stop>
          <MenuItem v-if="createProject && connectionState(menuRow) === 'ready'" @click="closeRowMenu(); createProject(menuRow.id)">
            <Icon name="folder-plus" size="sm" />{{ t('workspace.dialog.createTitle') }}
          </MenuItem>
          <MenuItem class="re-menu-edit" @click="startEdit(menuRow)">
            <Icon name="pencil" size="sm" />{{ t('settings.hosts.edit') }}
          </MenuItem>
          <MenuItem v-if="enabled(menuRow)" class="re-menu-reconnect" @click="reconnect(menuRow.id)">
            <Icon name="refresh" size="sm" />{{ t('settings.hosts.reconnect') }}
          </MenuItem>
          <template v-if="connectionState(menuRow) === 'ready'">
            <MenuItem separator />
            <MenuItem v-if="account(menuRow)?.status === 'signedOut'" class="re-menu-sign-in" @click="closeRowMenu(); store.openLogin(menuRow.id)">
              <Icon name="log-in" size="sm" />{{ t('workspace.hostNotice.signIn') }}
            </MenuItem>
            <MenuItem v-else-if="account(menuRow)?.status === 'signedIn'" class="re-menu-sign-out" @click="signOutRow(menuRow.id)">
              <Icon name="log-out" size="sm" />{{ signOutLabel() }}
            </MenuItem>
            <MenuItem class="re-menu-copy" :disabled="store.providerCopies[menuRow.id]?.status === 'copying'" @click="copyToRow(menuRow)">
              <Icon name="copy" size="sm" />{{ t('settings.hosts.copyLocal') }}
            </MenuItem>
          </template>
          <MenuItem separator />
          <MenuItem danger @click="remove(menuRow)">
            <Icon name="trash" size="sm" />{{ t('settings.hosts.delete') }}
          </MenuItem>
        </Menu>
      </Transition>
    </template>
  </section>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.re, .re-page { display: flex; flex-direction: column; }
.re { gap: var(--space-3); }
.re-page { gap: var(--space-4); }
.re-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.re-head-copy { min-width: 0; }
.re-head .sec-title { margin: 0; }
.re-row { display: flex; align-items: center; gap: var(--space-3); min-height: 60px; padding: 0 var(--space-3) 0 var(--space-4); transition: background var(--duration-fast) var(--ease-out); }
.re-row + .re-row, .re-item + .re-item { border-top: var(--p-hairline) solid var(--color-line); }
.re-row:hover { background: var(--color-hover); }
.re-item:has(> .re-row-setup, > .re-row-failure) > .re-row:hover { background: transparent; }
.re-row.flash { animation: ui-row-flash var(--duration-flash) var(--ease-out); }
.re-row-lead { display: flex; flex: 1; align-items: center; gap: var(--space-2); min-width: 0; align-self: stretch; }
.re-row-lead.expandable { cursor: pointer; }
.re-row-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.re-row-name { display: block; overflow: hidden; color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-sm); font-weight: var(--weight-option-label); text-overflow: ellipsis; white-space: nowrap; }
.re-row-status { display: flex; align-items: center; gap: var(--space-1-5); min-width: 0; color: var(--color-text-faint); font-size: var(--text-xs); }
.re-row-state { flex: none; }
.re-row-status--failed .re-row-state { color: var(--color-danger); }
.re-row-warning { color: var(--color-warning); }
.re-row-notice { color: var(--color-text-muted); }
.re-row-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.re-row-detail::before { content: '·'; margin-right: var(--space-1-5); }
.re-row-details { display: inline-flex; flex: 0 1 auto; align-items: center; min-width: 0; padding: 0; border: none; background: none; color: inherit; font: inherit; cursor: pointer; }
.re-row-details:hover { color: var(--color-text); }
.re-row-details:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: var(--p-focus-ring); }
.re-row-details-text { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; }
.re-row-details :deep(svg) { flex: none; }
.re-row.disabled .re-row-name { color: var(--color-text-faint); }
.re-row-actions { display: flex; flex: none; align-items: center; gap: var(--space-1); }
.re-row-create-project, .re-row-more { flex: none; color: var(--color-text-faint); }
.re-row-failure { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); padding: 0 var(--space-3) var(--space-3) var(--space-4); }
.re-row-failure > :first-child { align-self: stretch; min-width: 0; }
.re-row-failure :deep(.etr) { max-height: none; padding: 0; overflow: visible; background: none; border-radius: 0; }
.re-row-failure-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.re-row-more.open { background: var(--color-hover); color: var(--color-text); }
.re-row-setup { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); padding: 0 var(--space-3) var(--space-3) var(--space-4); font-family: var(--font-ui); }
.re-row-setup-text { margin: 0; color: var(--color-text-muted); font-size: var(--text-xs); }
.re-row-setup-text--danger { color: var(--color-danger); }
.re-row-setup-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.re-empty { padding: var(--space-6) var(--space-4); font-family: var(--font-ui); text-align: center; }
.re-empty-title { color: var(--color-text-faint); font-size: var(--text-sm); }
.re-empty-hint { margin-top: var(--space-1); color: var(--color-text-quaternary); font-size: var(--text-xs); }
.re-page-head {
  position: sticky;
  top: calc(-1 * var(--space-2));
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: calc(-1 * var(--space-2)) 0 0;
  padding: var(--space-2) 0;
  border-bottom: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
}
.re-back { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-left: calc(-1 * var(--space-2)); border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.re-back:hover { background: var(--color-hover); color: var(--color-text-strong); }
.re-back:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.re-page-title { flex: 1; min-width: 0; overflow: hidden; color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.re-input-row { display: flex; align-items: center; gap: var(--space-2); }
.re-input-row > :first-child { flex: 1; min-width: 0; }
.re-browse { flex: none; }
.re-hosts { display: flex; flex-direction: column; gap: var(--space-2); }
.re-hosts-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 28px; }
.re-hosts-actions { display: flex; align-items: center; gap: var(--space-1); flex: none; }
.re-hosts-note { margin: 0; padding: var(--space-4); border-radius: var(--radius-xl); background: var(--color-surface); color: var(--color-text-faint); font-family: var(--font-ui); font-size: var(--text-xs); text-align: center; }
.re-page-hint { margin: 0; color: var(--color-text-faint); font-size: var(--text-xs); }
.re-host { min-height: 44px; }
.re-host .re-row-copy { flex-direction: row; align-items: baseline; gap: var(--space-3); }
.re-host-target { overflow: hidden; color: var(--color-text-faint); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.re-host-add { flex: none; }
.re-advanced { display: flex; flex-direction: column; gap: var(--space-3); }
.re-advanced-toggle { display: inline-flex; align-items: center; gap: var(--space-1); align-self: flex-start; padding: 0; border: none; background: none; color: var(--color-text-muted); font-family: var(--font-ui); font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer; }
.re-advanced-toggle:hover { color: var(--color-text); }
.re-advanced-toggle:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: var(--p-focus-ring); }
.re-advanced-body { display: flex; flex-direction: column; gap: var(--space-4); padding-left: var(--space-4); border-left: var(--p-hairline) solid var(--color-line); }
.re-foot {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-4);
  padding-bottom: var(--space-2);
  border-top: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
  box-shadow: 0 var(--space-5) 0 var(--color-bg);
}
.re-foot--result { border-top: none; }
.re-foot-actions { display: flex; align-items: center; gap: var(--space-2); }
.re-spacer { flex: 1; }
</style>
