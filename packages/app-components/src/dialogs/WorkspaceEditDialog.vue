<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppHost } from '@moonshot-ai/app-core/api';
import { basename, hostDisplayName, hostDisplayState, isHostBlocked } from '@moonshot-ai/app-core/lib';
import { Badge, Banner, Button, Dialog, Field, Icon, IconButton, Input, Select, Spinner, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { hostsStore } from '@moonshot-ai/app-client/stores';

const LOCAL_SOURCE = '';
const MANAGE_HOSTS = '__manage__';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    mode: 'create' | 'edit';
    initialName?: string;
    initialDirs?: string[];
    initialHostId?: string;
    pick: () => Promise<string[]>;
    pickRemote?: (hostId: string, path: string) => Promise<string[]>;
    hosts?: AppHost[];
    manageHosts?: () => void;
    importProjectConfig?: (primary: string, hostId?: string) => Promise<string[] | undefined>;
    busy?: boolean;
    primaryImmutable?: boolean;
  }>(),
  {
    initialName: '',
    initialDirs: () => [],
    hosts: () => [],
    busy: false,
    primaryImmutable: false,
  },
);

const emit = defineEmits<{
  submit: [payload: { name: string; dirs: string[]; hostId?: string; projectConfigDirs: string[] }];
  cancel: [];
}>();

function hostState(host: AppHost) {
  return hostDisplayState(host.id, host, { loaded: true, connecting: hostsStore().connecting[host.id] === true });
}

function initialSourceId(): string {
  const id = props.initialHostId;
  if (id === undefined) return LOCAL_SOURCE;
  if (props.mode === 'edit') return id;
  const candidate = props.hosts.find((host) => host.id === id);
  if (candidate !== undefined && isHostBlocked(hostState(candidate))) return LOCAL_SOURCE;
  return id;
}

const open = ref(true);
const nameInput = ref<InstanceType<typeof Input>>();
const firstInitialDir = props.initialDirs[0];
const name = ref(
  props.initialName !== ''
    ? props.initialName
    : props.mode === 'create' && firstInitialDir !== undefined
      ? basename(firstInitialDir)
      : '',
);
const nameTouched = ref(props.initialName !== '');
const dirs = ref<string[]>([...props.initialDirs]);
const projectConfigDirs = ref<string[]>([]);
const picking = ref(false);
const pickFailed = ref(false);
const importing = ref(false);
const importHint = ref<'empty' | 'failed' | null>(null);
const primaryStatus = ref('');
const dirList = ref<HTMLElement>();
const sourceId = ref(initialSourceId());
const hostId = computed(() => (sourceId.value === LOCAL_SOURCE ? undefined : sourceId.value));
const hostName = computed(() => {
  if (hostId.value === undefined) return '';
  const host = props.hosts.find((candidate) => candidate.id === hostId.value);
  return host === undefined ? hostsStore().displayName(hostId.value) ?? t('workspace.deletedHost') : hostDisplayName(host);
});
const selectedHostState = computed(() => {
  if (hostId.value === undefined) return 'local' as const;
  const candidate = props.hosts.find((host) => host.id === hostId.value) ?? hostsStore().hostFor(hostId.value);
  return hostDisplayState(hostId.value, candidate, {
    loaded: props.hosts.length > 0 || hostsStore().loaded,
    connecting: hostsStore().connecting[hostId.value] === true,
  });
});
const selectedHostBlocked = computed(() => isHostBlocked(selectedHostState.value));
const remoteOptions = computed(() => props.hosts.map((host) => {
  const state = hostState(host);
  return {
    value: host.id,
    label: hostDisplayName(host),
    description: [host.host, t(`workspace.hostState.${state}`)].filter(Boolean).join(' · '),
    disabled: isHostBlocked(state),
  };
}));
const sourceOptions = computed(() => [
  { value: LOCAL_SOURCE, label: t('workspace.dialog.localDevice') },
  ...remoteOptions.value,
  ...(props.manageHosts === undefined ? [] : [{
    value: MANAGE_HOSTS,
    label: t('workspace.dialog.manageHosts'),
    trailingIcon: 'arrow-up-right',
  }]),
]);
const showSourceField = computed(() => props.mode === 'create' && (remoteOptions.value.length > 0 || props.manageHosts !== undefined));
const canImportProjectConfig = computed(() => props.importProjectConfig !== undefined && dirs.value.length > 0 && !selectedHostBlocked.value);
const submitHint = computed(() => {
  if (selectedHostBlocked.value && (selectedHostState.value === 'failed' || selectedHostState.value === 'disabled' || selectedHostState.value === 'missing')) {
    return t(`workspace.hostNotice.${selectedHostState.value}`, { name: hostName.value });
  }
  if (dirs.value.length === 0) return t('workspace.dialog.submitMissingDirs');
  if (name.value.trim().length === 0) return t('workspace.dialog.submitMissingName');
  return '';
});

watch(sourceId, (selected, previous) => {
  if (selected === MANAGE_HOSTS) {
    sourceId.value = previous;
    props.manageHosts?.();
    return;
  }
  if (previous === MANAGE_HOSTS || props.mode !== 'create' || dirs.value.length === 0) return;
  dirs.value = [];
  projectConfigDirs.value = [];
  importHint.value = null;
  pickFailed.value = false;
  prefillNameFromDirs();
});

function prefillNameFromDirs(): void {
  primaryStatus.value = '';
  if (props.mode !== 'create' || nameTouched.value) return;
  const first = dirs.value[0];
  name.value = first === undefined ? '' : basename(first);
}

function appendDirs(added: readonly string[]): void {
  const existing = new Set(dirs.value);
  dirs.value = [...dirs.value, ...added.filter((dir) => !existing.has(dir))];
  prefillNameFromDirs();
}

async function addDirectory(): Promise<void> {
  if (props.busy || picking.value || importing.value || selectedHostBlocked.value) return;
  const target = hostId.value;
  if (target !== undefined && props.pickRemote === undefined) return;
  picking.value = true;
  pickFailed.value = false;
  try {
    if (target === undefined) {
      appendDirs(await props.pick());
    } else {
      appendDirs(await props.pickRemote!(target, dirs.value[0] ?? ''));
    }
  } catch {
    pickFailed.value = true;
  } finally {
    picking.value = false;
  }
}

async function importDirs(): Promise<void> {
  const fetcher = props.importProjectConfig;
  const primary = dirs.value[0];
  if (fetcher === undefined || primary === undefined || selectedHostBlocked.value || props.busy || picking.value || importing.value) return;
  importing.value = true;
  importHint.value = null;
  try {
    const result = await fetcher(primary, hostId.value);
    if (result === undefined) {
      importHint.value = 'failed';
      return;
    }
    const existing = new Set(dirs.value);
    const fresh = result.filter((path) => !existing.has(path));
    if (fresh.length === 0) {
      importHint.value = 'empty';
      return;
    }
    appendDirs(fresh);
    projectConfigDirs.value = [...projectConfigDirs.value, ...fresh];
  } catch {
    importHint.value = 'failed';
  } finally {
    importing.value = false;
  }
}

function removeDir(target: string): void {
  if (props.busy || picking.value || importing.value) return;
  dirs.value = dirs.value.filter((dir) => dir !== target);
  projectConfigDirs.value = projectConfigDirs.value.filter((path) => path !== target);
  prefillNameFromDirs();
}

async function promoteDir(target: string): Promise<void> {
  if (props.busy || picking.value || importing.value) return;
  const previousPrimary = dirs.value[0];
  dirs.value = [target, ...dirs.value.filter((dir) => dir !== target)];
  primaryStatus.value = t('workspace.dialog.primaryChanged', { name: basename(target) });
  await nextTick();
  if (previousPrimary === undefined) return;
  const row = [...(dirList.value?.querySelectorAll<HTMLElement>('.we-dir-row') ?? [])]
    .find((element) => element.dataset.dirKey === previousPrimary);
  row?.querySelector<HTMLButtonElement>('.we-dir-primary')?.focus();
}

const canSubmit = computed(
  () => !props.busy && !picking.value && !importing.value && !selectedHostBlocked.value && dirs.value.length > 0 && name.value.trim().length > 0,
);

function submit(): void {
  if (!canSubmit.value) return;
  const deduped = [...new Set(dirs.value)];
  emit('submit', {
    name: name.value.trim(),
    dirs: deduped,
    hostId: hostId.value,
    projectConfigDirs: projectConfigDirs.value.filter((path) => deduped.includes(path)),
  });
}

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();
function onNameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  submit();
}
function onNameKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isComposingKeyEvent(e)) e.stopPropagation();
}
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="mode === 'create' ? t('workspace.dialog.createTitle') : t('workspace.dialog.editTitle')"
    size="md"
    panel-class="we-panel"
    :initial-focus="() => nameInput?.el ?? null"
    :close-on-overlay="!busy"
    :close-on-esc="!busy"
    :hide-close="busy"
    @close="emit('cancel')"
  >
    <div class="we">
      <Field v-if="showSourceField" :label="t('workspace.dialog.sourceLabel')">
        <Select
          v-model="sourceId"
          class="we-source-select"
          :options="sourceOptions"
          :aria-label="t('workspace.dialog.sourceLabel')"
          :disabled="busy || picking || importing"
        />
      </Field>

      <Field :label="t('workspace.dialog.nameLabel')">
        <Input
          ref="nameInput"
          v-model="name"
          :placeholder="t('workspace.dialog.namePlaceholder')"
          :disabled="busy"
          autocomplete="off"
          spellcheck="false"
          @update:model-value="nameTouched = true"
          @keydown.enter.stop="onNameEnter"
          @keydown="onNameKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
      </Field>

      <div class="we-dirs">
        <div class="we-dirs-head">
          <span class="we-dirs-label">{{ t('workspace.dialog.dirsLabel') }}</span>
          <span v-if="dirs.length > 0" class="we-dirs-actions">
            <Tooltip
              v-if="canImportProjectConfig"
              :text="t('workspace.dialog.importProjectConfigTooltip')"
            >
              <Button
                variant="ghost"
                size="xs"
                :disabled="busy || picking || importing || selectedHostBlocked"
                :loading="importing"
                @click="importDirs"
              >
                <Icon name="download" size="sm" />{{ t('workspace.dialog.importProjectConfig') }}
              </Button>
            </Tooltip>
            <Button
              class="we-add-directory"
              variant="ghost"
              size="xs"
              :disabled="busy || picking || importing || selectedHostBlocked"
              :loading="picking"
              @click="addDirectory"
            >
              <Icon name="plus" size="sm" />{{ t('workspace.dialog.addDirs') }}
            </Button>
          </span>
        </div>

        <button
          v-if="dirs.length === 0"
          class="we-drop we-add-directory"
          type="button"
          :disabled="busy || picking || importing || selectedHostBlocked"
          @click="addDirectory"
        >
          <Spinner v-if="picking" size="sm" />
          <Icon v-else name="plus" size="md" />
          <span>{{ hostId === undefined ? t('workspace.dialog.emptyDirs') : t('workspace.dialog.emptyDirsFrom', { device: hostName }) }}</span>
        </button>

        <div v-if="dirs.length > 0" ref="dirList" class="we-dir-list">
          <div
            v-for="(dir, i) in dirs"
            :key="dir"
            class="we-dir-row"
            :data-dir-key="dir"
          >
            <Icon class="we-dir-icon" name="folder-closed" size="md" />
            <div class="we-dir-copy">
              <div class="we-dir-heading">
                <Tooltip :text="dir">
                  <span
                    class="we-dir-name"
                    :class="{ 'we-dir-name--with-host': hostName }"
                    tabindex="0"
                    :aria-label="dir"
                  >{{ basename(dir) }}</span>
                </Tooltip>
                <span v-if="hostName" class="we-dir-host" :title="hostName">{{ hostName }}</span>
              </div>
            </div>
            <Badge v-if="i === 0" class="we-dir-badge" size="sm" variant="outline">
              {{ t('workspace.dialog.primaryBadge') }}
            </Badge>
            <span v-else-if="primaryImmutable" aria-hidden="true" />
            <Button
              v-else
              variant="ghost"
              size="xs"
              class="we-dir-primary"
              :disabled="busy || picking || importing"
              @click="promoteDir(dir)"
            >
              {{ t('workspace.dialog.setPrimary') }}
            </Button>
            <IconButton
              v-if="mode === 'create' || i > 0"
              class="we-dir-rm"
              size="sm"
              :label="t('workspace.dialog.removeDir')"
              :tooltip="t('workspace.dialog.removeDir')"
              :disabled="busy || picking || importing"
              @click="removeDir(dir)"
            >
              <Icon name="close" size="sm" />
            </IconButton>
            <span v-else class="we-dir-rm" aria-hidden="true" />
          </div>
        </div>

        <Banner v-if="pickFailed" class="we-pick-error" variant="danger" role="alert">{{ t('workspace.dialog.pickFailed') }}</Banner>
        <div v-if="importHint === 'empty'" class="we-import-hint">
          {{ t('workspace.dialog.importProjectConfigEmpty') }}
        </div>
        <div v-else-if="importHint === 'failed'" class="we-import-hint">
          {{ t('workspace.dialog.importProjectConfigFailed') }}
        </div>
        <div class="we-primary-status" role="status">{{ primaryStatus }}</div>
      </div>
    </div>

    <template #foot>
      <Button variant="ghost" :disabled="busy" @click="emit('cancel')">{{ t('workspace.cancel') }}</Button>
      <Tooltip :text="submitHint" placement="top">
        <Button variant="primary" :disabled="!canSubmit" :loading="busy" @click="submit">
          {{ mode === 'create' ? t('workspace.dialog.create') : t('workspace.dialog.save') }}
        </Button>
      </Tooltip>
    </template>
  </Dialog>
</template>

<style scoped>
.we-dir-host {
  min-width: 0;
  max-width: 120px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.we {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: 4px;
}

.we-dirs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: 6px;
}
.we-dirs-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-left: auto;
}
.we-dirs-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}

.we-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 140px;
  border: var(--p-hairline) dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  background: none;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    border-color var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.we-drop:hover:not(:disabled) {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.we-drop:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.we-drop:disabled { cursor: default; opacity: 0.6; }

.we-dir-list {
  display: grid;
  grid-template-columns: calc(20px + var(--space-3)) minmax(0, 1fr) auto calc(28px + var(--space-3));
  column-gap: var(--space-2);
  align-content: start;
  max-height: 280px;
  overflow-y: auto;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
}
.we-dir-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  padding: var(--space-2) var(--space-3);
}
.we-dir-row + .we-dir-row {
  border-top: var(--p-hairline) solid var(--color-line);
}
.we-dir-icon {
  color: var(--color-text-muted);
}
.we-dir-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-1);
}
.we-dir-heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: var(--space-2);
}
.we-dir-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.we-dir-name--with-host {
  flex: 0 1 auto;
  max-width: 60%;
}
.we-dir-name:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.we-dir-badge {
  justify-self: center;
}
.we-dir-primary {
  justify-self: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.we-dir-row .we-dir-primary,
.we-dir-row .we-dir-primary:disabled {
  opacity: 0;
}
.we-dir-row:hover .we-dir-primary:not(:disabled),
.we-dir-row:focus-within .we-dir-primary:not(:disabled) {
  opacity: 1;
}
.we-dir-row:hover .we-dir-primary:disabled,
.we-dir-row:focus-within .we-dir-primary:disabled {
  opacity: 0.5;
}
@media (hover: none) {
  .we-dir-row .we-dir-primary:not(:disabled) { opacity: 1; }
  .we-dir-row .we-dir-primary:disabled { opacity: 0.5; }
}
.we-dir-rm {
  width: 28px;
}
.we-import-hint,
.we-pick-error {
  margin-top: var(--space-2);
}
.we-import-hint {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.we-primary-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 560px) {
  .we-dirs-head { align-items: flex-start; }
  .we-dirs-actions { width: 100%; justify-content: flex-end; }
  .we-dir-list { grid-template-columns: calc(18px + var(--space-2)) minmax(0, 1fr) auto calc(26px + var(--space-2)); }
  .we-dir-row { padding-inline: var(--space-2); }
}
</style>

<style>
.ui-dialog.we-panel {
  width: min(540px, 100%);
}
</style>
