<script setup lang="ts">
import { v4 as randomUUID } from 'uuid';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppDevice, AppDeviceConnectFailure, AppDeviceUpgradeStatus, AppSshConfigHost, AppSshConfigHosts, AppSshDeviceDefinition } from '@moonshot-ai/app-core/api';
import { deviceDisplayName, deviceDisplayState, providerDisplayName } from '@moonshot-ai/app-core/lib';
import { isImeKeyEvent } from '@moonshot-ai/app-client/lib';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { deviceDefinition, devicesStore, type DeviceAccount, type DeviceProviderCopy } from '@moonshot-ai/app-client/stores';
import { Banner, Button, Field, Icon, IconButton, Input, Menu, MenuItem, SegmentedControl, StatusDot, Switch, Tooltip } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';
import { useDeviceRowReveal } from '../composables/useDeviceRowReveal';
import { useDeviceFailureText } from '../composables/useDeviceFailureText';
import DeviceTestResult from './DeviceTestResult.vue';

const props = defineProps<{
  openSshConfig?: (path: string) => void;
  pickIdentityFile?: (defaultPath?: string) => Promise<string | undefined>;
  createProject?: (deviceId: string) => void;
}>();

const emit = defineEmits<{
  page: [open: boolean];
}>();

const { locale, t } = useI18n();
const store = devicesStore();
const { confirm } = useConfirmDialog();
const failureText = useDeviceFailureText();
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
const testFailure = ref<{ failure?: AppDeviceConnectFailure; reason: string; hint: string; detail: string }>();
const pendingIds = ref<Record<string, boolean>>({});
const backButton = ref<InstanceType<typeof IconButton>>();
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
const { flashId, flash: flashRow, reveal: revealRow } = useDeviceRowReveal(rootEl);
let copyFeedbackTimer = 0;
let testAbort: AbortController | undefined;

const sshDevices = computed(() => store.devices.filter((row) => row.connection === 'ssh'));
const original = computed(() => sshDevices.value.find((row) => row.id === originalId.value));
const menuRow = computed(() => sshDevices.value.find((row) => row.id === rowMenuId.value));
const testState = computed(() => (testing.value ? 'running' : testFailure.value ? 'failed' : undefined));
const nameError = computed(() => {
  const value = name.value.trim();
  if (value === '') return t('settings.devices.nameRequired');
  if (value.length > 64) return t('settings.devices.nameTooLong');
  if (store.devices.some((row) => deviceDisplayName(row) === value && row.id !== originalId.value)) return t('settings.devices.nameDuplicate');
  return '';
});
const targetError = computed(() => host.value.trim() === '' ? t('settings.devices.targetRequired') : '');
const canSubmit = computed(() => nameError.value === '' && targetError.value === '' && !busy.value);
const configuredHosts = computed(() => new Set(sshDevices.value.map((row) => row.host)));
const detectedHosts = computed(() => (sshHosts.value?.hosts ?? []).filter((entry) => !configuredHosts.value.has(entry.alias)));
const subpage = computed(() => pageMode.value !== 'list');
const hasSourceTabs = computed(() => pageMode.value === 'add');
const showForm = computed(() => pageMode.value === 'edit' || (pageMode.value === 'add' && addTab.value === 'manual'));
const showHostPicker = computed(() => pageMode.value === 'add' && addTab.value === 'config');
const showDeviceList = computed(() => sshDevices.value.length > 0 || !sshHostsLoading.value);
const addSourceOptions = computed(() => [
  { value: 'config', label: t('settings.devices.sshHostsTitle') },
  { value: 'manual', label: t('settings.devices.addManually') },
]);
const writeBlocked = computed(() => busy.value || testing.value || addingHost.value !== '');

watch(subpage, (open) => emit('page', open), { immediate: true });

onUnmounted(() => {
  window.clearTimeout(copyFeedbackTimer);
  testAbort?.abort();
});

function enabled(row: AppDevice): boolean {
  return row.enabled !== false;
}

function connectionState(row: AppDevice) {
  return deviceDisplayState(row.id, row, {
    loaded: true,
    connecting: pendingIds.value[row.id] === true || store.connecting[row.id] === true,
    settledFailure: store.settledFailures[row.id],
  });
}

function upgradeOf(row: AppDevice): AppDeviceUpgradeStatus | undefined {
  const upgrade = store.upgradeStatus(row.id);
  if (upgrade !== 'failed') return upgrade;
  const state = connectionState(row);
  return state === 'ready' || state === 'outdated' ? upgrade : undefined;
}

function retrying(row: AppDevice): boolean {
  return upgradeOf(row) === undefined
    && connectionState(row) === 'connecting'
    && (row.connectError !== undefined || row.connectFailure !== undefined);
}

function statusKind(row: AppDevice): string {
  const upgrade = upgradeOf(row);
  return upgrade === undefined ? connectionState(row) : `upgrade-${upgrade}`;
}

function stateLabel(row: AppDevice): string {
  const upgrade = upgradeOf(row);
  if (upgrade !== undefined) return t(`workspace.deviceUpgrade.${upgrade}`);
  return t(`workspace.deviceState.${retrying(row) ? 'retrying' : connectionState(row)}`);
}

function failed(row: AppDevice): boolean {
  if (upgradeOf(row) !== undefined) return false;
  const state = connectionState(row);
  return state === 'failed' || state === 'outdated';
}

function showsFailure(row: AppDevice): boolean {
  return failed(row) || retrying(row);
}

function isExpandable(row: AppDevice): boolean {
  if (showsFailure(row)) return true;
  const notice = rowNotice(row);
  return notice === 'needsModels' || notice === 'copyFailed';
}

function upgradeInline(row: AppDevice): boolean {
  return store.canUpgrade(row.id) && connectionState(row) === 'outdated';
}

function canReconnect(row: AppDevice): boolean {
  return showsFailure(row) && !upgradeInline(row);
}

function failureOpen(row: AppDevice): boolean {
  return openDetailId.value === row.id && showsFailure(row);
}

function duplicateText(row: AppDevice): string {
  if (connectionState(row) !== 'duplicate' || row.duplicateOf === undefined) return '';
  return t('settings.devices.duplicateOf', { name: store.displayName(row.duplicateOf) ?? row.duplicateOf });
}

function toggleDetail(id: string): void {
  openDetailId.value = openDetailId.value === id ? '' : id;
}

function onRowLeadClick(row: AppDevice): void {
  if (isExpandable(row)) toggleDetail(row.id);
}

function rowFailureSummary(row: AppDevice): string {
  return failureText.label(row.connectFailure, row.remoteVersion)
    || (row.connectError ?? '').split('\n', 1)[0]?.trim()
    || t('settings.devices.showDetails');
}

function copyFeedback(row: AppDevice): DeviceProviderCopy | undefined {
  return copyFeedbackId.value === row.id && connectionState(row) === 'ready' ? store.providerCopies[row.id] : undefined;
}

function rowNotice(row: AppDevice): 'needsModels' | 'copyFailed' | 'copying' | 'copied' | undefined {
  if (connectionState(row) === 'ready' && store.needsLogin(row.id)) return 'needsModels';
  const status = copyFeedback(row)?.status;
  if (status === 'failed') return 'copyFailed';
  if (status === 'copying') return 'copying';
  if (status === 'done') return 'copied';
  return undefined;
}

function noticeOpen(row: AppDevice): boolean {
  const notice = rowNotice(row);
  return openDetailId.value === row.id && (notice === 'needsModels' || notice === 'copyFailed');
}

function noticeText(row: AppDevice): string {
  const notice = rowNotice(row);
  if (notice === 'needsModels') return t('settings.devices.setupNeeded');
  if (notice === 'copyFailed') return t('settings.devices.copyFailedStatus');
  if (notice === 'copying') return t('settings.devices.copyingStatus');
  const copy = copyFeedback(row);
  if (copy?.status !== 'done') return '';
  const names = copy.result.providers.map((id) => providerDisplayName(id, t));
  return names.length === 0
    ? t('settings.devices.localNone')
    : t('settings.devices.localCopied', { names: new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(names) });
}

function setupText(row: AppDevice): string {
  const copy = copyFeedback(row);
  if (copy?.status === 'failed') return t('settings.devices.localFailed');
  if (copy?.status === 'done' && copy.result.providers.length === 0) return t('settings.devices.localNone');
  return t('settings.devices.setupHint');
}

watch(() => (copyFeedbackId.value === '' ? undefined : store.providerCopies[copyFeedbackId.value]?.status), (status) => {
  window.clearTimeout(copyFeedbackTimer);
  if (status !== 'done') return;
  const deviceId = copyFeedbackId.value;
  copyFeedbackTimer = window.setTimeout(() => {
    if (copyFeedbackId.value === deviceId) copyFeedbackId.value = '';
  }, 4000);
});

function dotFor(row: AppDevice): string {
  const upgrade = upgradeOf(row);
  if (upgrade !== undefined) return upgrade === 'failed' ? 'error' : 'running';
  const state = connectionState(row);
  if (state === 'ready') return 'ok';
  if (state === 'connecting') return 'running';
  if (failed(row)) return 'error';
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

function applyFocusDevice(): void {
  const targetId = store.focusDeviceId;
  const openAdd = store.addIfEmpty;
  if (!targetId && !openAdd) return;
  if (!store.loaded) return;
  const row = targetId ? store.deviceFor(targetId) : undefined;
  if (row?.connection === 'account') return;
  store.requestFocus(null);
  cancelTest();
  fillForm(undefined);
  pageMode.value = 'list';
  if (openAdd && sshDevices.value.length === 0) {
    void startAdd();
    return;
  }
  if (!row) return;
  if (isExpandable(row)) openDetailId.value = row.id;
  revealRow(row.id);
}

watch(() => [store.focusDeviceId, store.addIfEmpty, store.loaded] as const, applyFocusDevice, { immediate: true });

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
  const taken = new Set(store.devices.map(deviceDisplayName));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base.slice(0, 60)}-${suffix}`)) suffix++;
  return `${base.slice(0, 60)}-${suffix}`;
}

async function toggleRowMenu(row: AppDevice, event: MouseEvent): Promise<void> {
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

function fillForm(row: AppDevice | undefined): void {
  originalId.value = row?.id ?? '';
  name.value = row === undefined ? '' : deviceDisplayName(row);
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
    void nextTick(() => backButton.value?.el?.focus({ preventScroll: true }));
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

function startEdit(row: AppDevice): void {
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

function draftDefinition(): AppSshDeviceDefinition {
  const displayName = name.value.trim();
  const target = host.value.trim();
  const unnamed = original.value !== undefined && original.value.name === undefined && displayName === original.value.id;
  return {
    connection: 'ssh',
    host: /^[^\s:/]+:\d+$/.test(target) ? `ssh://${target}` : target,
    identityFile: identityFile.value.trim() || undefined,
    remoteBin: remoteBin.value.trim() || undefined,
    name: unnamed ? undefined : displayName,
    enabled: original.value?.enabled === false ? false : undefined,
  };
}

function connectionKey(value: Pick<AppDevice, 'host' | 'identityFile' | 'remoteBin'>): string {
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
      hint: failureText.hint(result.connectFailure, { host: draftDefinition().host, name: name.value.trim() }),
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

function newDeviceId(): string {
  let deviceId: string;
  do deviceId = `device-${randomUUID().slice(0, 8)}`;
  while (store.devices.some((row) => row.id === deviceId));
  return deviceId;
}

async function writeDevice(existingId: string, saved: AppSshDeviceDefinition, expandOnFailure = false): Promise<string | undefined> {
  busy.value = true;
  clearResult();
  try {
    const deviceId = existingId || newDeviceId();
    try {
      await store.save(deviceId, saved);
    } catch {
      error.value = t('settings.devices.saveFailed');
      return undefined;
    }
    back();
    flashRow(deviceId);
    const savedRow = store.deviceFor(deviceId);
    if (expandOnFailure && savedRow && failed(savedRow)) {
      openDetailId.value = deviceId;
    }
    if (saved.enabled !== false) void reconnect(deviceId, expandOnFailure);
    return deviceId;
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
  await writeDevice(originalId.value, saved);
}

async function saveAnyway(): Promise<void> {
  if (!canSubmit.value || testing.value) return;
  await writeDevice(originalId.value, draftDefinition(), true);
}

async function addHost(entry: AppSshConfigHost): Promise<void> {
  if (writeBlocked.value) return;
  addingHost.value = entry.alias;
  try {
    await writeDevice('', { connection: 'ssh', name: availableName(entry.alias), host: entry.alias }, true);
  } finally {
    addingHost.value = '';
  }
}

async function setEnabled(row: AppDevice, value: boolean): Promise<void> {
  if (pendingIds.value[row.id] || busy.value || value === enabled(row)) return;
  error.value = '';
  pendingIds.value = { ...pendingIds.value, [row.id]: true };
  try {
    await store.save(row.id, { ...deviceDefinition(row), enabled: value ? undefined : false });
  } catch {
    error.value = t('settings.devices.saveFailed');
    return;
  } finally {
    const next = { ...pendingIds.value };
    delete next[row.id];
    pendingIds.value = next;
  }
  if (value) void reconnect(row.id);
}

function copyRow(deviceId: string): void {
  copyFeedbackId.value = deviceId;
  void store.copyProviders(deviceId);
}

async function copyToRow(row: AppDevice): Promise<void> {
  closeRowMenu();
  if (await failureText.confirmCopy(deviceDisplayName(row))) copyRow(row.id);
}

async function reconnect(deviceId: string, expandOnFailure = false): Promise<void> {
  closeRowMenu();
  try {
    await store.connect(deviceId);
  } catch {
    await reload();
  }
  if (expandOnFailure) {
    const row = store.deviceFor(deviceId);
    if (row && failed(row)) openDetailId.value = deviceId;
  }
}

function upgradeRow(deviceId: string): void {
  closeRowMenu();
  void store.upgrade(deviceId);
}

function account(row: AppDevice): DeviceAccount | undefined {
  return connectionState(row) === 'ready' ? store.accounts[row.id] : undefined;
}

function signOutLabel(): string {
  return t('settings.devices.kimiSignOut');
}

async function signOutRow(deviceId: string): Promise<void> {
  closeRowMenu();
  error.value = '';
  try {
    await store.signOut(deviceId);
  } catch {
    error.value = t('settings.devices.signOutFailed');
  }
}

async function remove(row: AppDevice): Promise<void> {
  closeRowMenu();
  if (busy.value) return;
  const ok = await confirm({
    title: t('settings.devices.deleteTitle'),
    message: t('settings.devices.deleteMessage', { name: deviceDisplayName(row) }),
    confirmLabel: t('settings.devices.delete'),
    variant: 'danger',
  });
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await store.remove(row.id);
    back();
  } catch {
    error.value = t('settings.devices.deleteFailed');
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
      <IconButton ref="backButton" class="re-nav" size="sm" :label="t('settings.devices.back')" @click="back">
        <Icon name="arrow-left" size="sm" />
      </IconButton>
      <span class="re-page-title">{{ pageMode === 'edit' && original ? deviceDisplayName(original) : t('settings.devices.add') }}</span>
    </div>
    <div v-else class="re-head">
      <slot name="title">
        <h3 class="sec-title">{{ t('settings.devices.sshTitle') }}</h3>
      </slot>
      <Button variant="secondary" size="sm" :disabled="busy" @click="startAdd">
        <Icon name="plus" size="sm" />{{ t('settings.devices.addHost') }}
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
        <IconButton v-if="openSshConfig && sshHosts?.exists" class="re-hosts-open" size="sm" :label="t('settings.devices.openSshConfig')" :tooltip="t('settings.devices.openSshConfig')" @click="openSshConfig(sshHosts.configPath)">
          <Icon name="external-link" size="sm" />
        </IconButton>
        <IconButton class="re-hosts-refresh" size="sm" :label="t('settings.devices.sshHostsRefresh')" :tooltip="t('settings.devices.sshHostsRefresh')" :disabled="sshHostsLoading" @click="loadHosts">
          <Icon name="refresh" size="sm" />
        </IconButton>
      </div>
    </div>

    <template v-if="showForm">
      <p class="re-page-hint">{{ t('settings.devices.formHint') }}</p>

      <Field :label="t('settings.devices.nameLabel')" :error="name !== '' ? nameError : ''">
        <Input ref="nameInput" v-model="name" size="sm" :placeholder="t('settings.devices.namePlaceholder')" :disabled="busy || testing" :error="name !== '' && nameError !== ''" autocomplete="off" spellcheck="false" @update:model-value="clearResult" />
      </Field>
      <Field :label="t('settings.devices.targetLabel')" :error="targetTouched ? targetError : ''" :hint="t('settings.devices.targetHint')">
        <Input v-model="host" size="sm" :placeholder="t('settings.devices.targetPlaceholder')" :disabled="busy || testing" :error="targetTouched && targetError !== ''" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="targetTouched = true; clearResult()" />
      </Field>
      <Field :label="t('settings.devices.identityLabel')" :hint="t('settings.devices.identityHint')">
        <div class="re-input-row">
          <Input v-model="identityFile" size="sm" placeholder="~/.ssh/id_ed25519" :disabled="busy || testing" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="clearResult" />
          <Button v-if="pickIdentityFile" class="re-browse" variant="secondary" size="sm" :disabled="busy || testing" @click="browseIdentityFile">{{ t('settings.devices.identityBrowse') }}</Button>
        </div>
      </Field>

      <div class="re-advanced">
        <button type="button" class="re-advanced-toggle" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
          <Icon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" size="sm" />{{ t('settings.devices.advanced') }}
        </button>
        <div v-if="advancedOpen" class="re-advanced-body">
          <Field :label="t('settings.devices.binLabel')" :hint="t('settings.devices.binHint')">
            <Input v-model="remoteBin" size="sm" placeholder="~/.kimi-code/bin/kimi" :disabled="busy || testing" autocomplete="off" autocapitalize="off" spellcheck="false" @update:model-value="clearResult" />
          </Field>
        </div>
      </div>

      <div class="re-foot" :class="{ 're-foot--result': testState }">
        <DeviceTestResult
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
          <Button v-if="pageMode === 'edit' && original" variant="danger" size="sm" :disabled="busy || testing" @click="remove(original)">{{ t('settings.devices.delete') }}</Button>
          <span class="re-spacer" />
          <Button variant="secondary" size="sm" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</Button>
          <Button v-if="testState === 'failed'" class="re-save-anyway" variant="secondary" size="sm" :disabled="!canSubmit" @click="saveAnyway">{{ t('settings.devices.saveAnyway') }}</Button>
          <Button class="re-save" variant="primary" size="sm" :loading="busy || testing" :disabled="!canSubmit || testing" @click="save">{{ t(testState === 'failed' ? 'settings.devices.retry' : 'settings.devices.save') }}</Button>
        </div>
      </div>
    </template>

    <section v-else-if="showHostPicker" class="re-hosts" :aria-label="t('settings.devices.sshHostsTitle')">
      <p v-if="sshHostsFailed" class="re-hosts-note">{{ t('settings.devices.sshHostsFailed') }}</p>
      <div v-else-if="detectedHosts.length > 0" class="settings-group re-hosts-list" role="list">
        <div v-for="entry in detectedHosts" :key="entry.alias" class="re-row re-host" role="listitem">
          <span class="re-row-copy">
            <span class="re-row-name">{{ entry.alias }}</span>
            <span v-if="hostTarget(entry) !== entry.alias" class="re-host-target" :title="hostTarget(entry)">{{ hostTarget(entry) }}</span>
          </span>
          <Button class="re-host-add" variant="secondary" size="xs" :loading="addingHost === entry.alias" :disabled="writeBlocked" @click="addHost(entry)">{{ t('settings.devices.addHost') }}</Button>
        </div>
      </div>
      <p v-else-if="sshHosts && !sshHosts.exists" class="re-hosts-note">{{ t('settings.devices.sshHostsMissing') }}</p>
      <p v-else-if="sshHosts && sshHosts.hosts.length === 0" class="re-hosts-note">{{ t('settings.devices.sshHostsEmpty') }}</p>
      <p v-else-if="sshHosts" class="re-hosts-note">{{ t('settings.devices.sshHostsAllAdded') }}</p>
      <Banner v-if="error" variant="danger" role="alert">{{ error }}</Banner>
    </section>

    <template v-else>
      <div v-if="showDeviceList" class="settings-group" role="list" :aria-label="t('settings.devices.sshTitle')">
        <div v-if="sshDevices.length === 0" class="re-empty">
          {{ detectedHosts.length > 0 ? t('settings.devices.emptyDetectedHint', { count: detectedHosts.length }) : t('settings.devices.emptyHint') }}
        </div>
        <div v-for="row in sshDevices" :key="row.id" class="re-item" :data-device-id="row.id" role="listitem">
          <div class="re-row" :class="{ disabled: !enabled(row), flash: flashId === row.id }">
            <div class="re-row-lead" :class="{ expandable: isExpandable(row) }" @click="onRowLeadClick(row)">
              <span class="re-row-copy">
                <span class="re-row-name">{{ deviceDisplayName(row) }}</span>
                <span v-if="enabled(row)" class="re-row-status" :class="`re-row-status--${statusKind(row)}`">
                  <StatusDot :status="dotFor(row)" />
                  <span class="re-row-state">{{ stateLabel(row) }}</span>
                  <span v-if="upgradeOf(row) === 'failed' && row.upgradeError" class="re-row-detail" :title="row.upgradeError">{{ row.upgradeError.split('\n', 1)[0] }}</span>
                  <Tooltip v-else-if="showsFailure(row)" :text="row.connectError">
                    <button
                      type="button"
                      class="re-row-detail re-row-error re-row-details"
                      :aria-expanded="failureOpen(row)"
                      @click.stop="toggleDetail(row.id)"
                    >
                      <span class="re-row-details-text">{{ rowFailureSummary(row) }}</span>
                      <Icon :name="failureOpen(row) ? 'chevron-down' : 'chevron-right'" size="sm" />
                    </button>
                  </Tooltip>
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
                  <span v-else-if="duplicateText(row)" class="re-row-detail re-row-notice" :title="duplicateText(row)">{{ duplicateText(row) }}</span>
                </span>
              </span>
            </div>
            <Button v-if="upgradeInline(row)" class="re-row-upgrade" variant="secondary" size="xs" @click="upgradeRow(row.id)">{{ t('settings.devices.upgradeShort') }}</Button>
            <Button v-else-if="canReconnect(row)" class="re-row-action re-row-reconnect" variant="secondary" size="xs" :loading="retrying(row)" @click="reconnect(row.id)">{{ t('settings.devices.reconnect') }}</Button>
            <Tooltip :text="t('settings.devices.useHere')">
              <Switch
                :model-value="enabled(row)"
                :label="t('settings.devices.enabledLabel', { name: deviceDisplayName(row) })"
                :disabled="pendingIds[row.id] === true || busy"
                @update:model-value="setEnabled(row, $event)"
              />
            </Tooltip>
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
                :label="t('settings.devices.options')"
                :tooltip="t('settings.devices.options')"
                aria-haspopup="menu"
                :aria-expanded="rowMenuOpen && rowMenuId === row.id"
                @click.stop="toggleRowMenu(row, $event)"
              >
                <Icon name="dots-horizontal" />
              </IconButton>
            </span>
          </div>
          <div v-if="failureOpen(row)" class="re-row-failure">
            <DeviceTestResult
              state="failed"
              :endpoint="row.host ?? ''"
              :failure="upgradeInline(row) ? undefined : row.connectFailure"
              :hint="failureText.hint(row.connectFailure, { host: row.host, name: deviceDisplayName(row) })"
              :detail="row.connectError ?? ''"
            />
            <div class="re-row-failure-actions">
              <Button class="re-row-edit" variant="secondary" size="xs" @click="startEdit(row)">{{ t('settings.devices.edit') }}</Button>
            </div>
          </div>
          <div v-if="noticeOpen(row) && rowNotice(row) === 'needsModels'" class="re-row-setup">
            <p class="re-row-setup-text" :class="{ 're-row-setup-text--danger': copyFeedback(row)?.status === 'failed' }">{{ setupText(row) }}</p>
            <div class="re-row-setup-actions">
              <Button class="re-row-sign-in" variant="primary" size="xs" @click="store.openLogin(row.id)">{{ t('workspace.deviceNotice.signIn') }}</Button>
              <Button class="re-row-copy-local" variant="secondary" size="xs" :loading="store.providerCopies[row.id]?.status === 'copying'" @click="copyToRow(row)">{{ t('workspace.deviceNotice.useLocal') }}</Button>
            </div>
          </div>
          <div v-else-if="noticeOpen(row)" class="re-row-setup">
            <Button class="re-row-copy-retry" variant="secondary" size="xs" @click="copyRow(row.id)">{{ t('settings.devices.retry') }}</Button>
          </div>
        </div>
      </div>

      <Banner v-if="error" variant="danger" role="alert">{{ error }}</Banner>
      <Banner v-if="loadFailed" variant="warning">{{ t('settings.devices.statusFailed') }}</Banner>

      <Transition name="ui-menu-pop">
        <Menu v-if="rowMenuOpen && menuRow" ref="rowMenuRef" class="ui-menu-floating re-row-menu" :style="rowMenuStyle" @click.stop>
          <MenuItem v-if="createProject && connectionState(menuRow) === 'ready'" @click="closeRowMenu(); createProject(menuRow.id)">
            <Icon name="folder-plus" size="sm" />{{ t('workspace.dialog.createTitle') }}
          </MenuItem>
          <MenuItem class="re-menu-edit" @click="startEdit(menuRow)">
            <Icon name="pencil" size="sm" />{{ t('settings.devices.edit') }}
          </MenuItem>
          <MenuItem v-if="enabled(menuRow)" class="re-menu-reconnect" @click="reconnect(menuRow.id)">
            <Icon name="refresh" size="sm" />{{ t('settings.devices.reconnect') }}
          </MenuItem>
          <MenuItem v-if="store.canUpgrade(menuRow.id) && !upgradeInline(menuRow)" class="re-menu-upgrade" @click="upgradeRow(menuRow.id)">
            <Icon name="download" size="sm" />{{ t('settings.devices.upgrade') }}
          </MenuItem>
          <template v-if="connectionState(menuRow) === 'ready'">
            <MenuItem separator />
            <MenuItem v-if="account(menuRow)?.status === 'signedOut'" class="re-menu-sign-in" @click="closeRowMenu(); store.openLogin(menuRow.id)">
              <Icon name="log-in" size="sm" />{{ t('workspace.deviceNotice.signIn') }}
            </MenuItem>
            <MenuItem v-else-if="account(menuRow)?.status === 'signedIn'" class="re-menu-sign-out" @click="signOutRow(menuRow.id)">
              <Icon name="log-out" size="sm" />{{ signOutLabel() }}
            </MenuItem>
            <MenuItem class="re-menu-copy" :disabled="store.providerCopies[menuRow.id]?.status === 'copying'" @click="copyToRow(menuRow)">
              <Icon name="copy" size="sm" />{{ t('settings.devices.copyLocal') }}
            </MenuItem>
          </template>
          <MenuItem separator />
          <MenuItem danger @click="remove(menuRow)">
            <Icon name="trash" size="sm" />{{ t('settings.devices.delete') }}
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
.re-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 28px; }
.re-head .sec-title { margin: 0; }
.re-row { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: 0 var(--space-3) 0 var(--space-4); transition: background var(--duration-fast) var(--ease-out); }
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
.re-row-status--failed .re-row-state,
.re-row-status--outdated .re-row-state,
.re-row-status--upgrade-failed .re-row-state { color: var(--color-danger); }
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
.re-row-upgrade, .re-row-action { flex: none; }
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
.re-empty { padding: var(--space-4); color: var(--color-text-faint); font-family: var(--font-ui); font-size: var(--text-xs); line-height: var(--leading-normal); text-align: center; }
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
.re-nav { margin-left: calc(-1 * var(--space-2)); }
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
