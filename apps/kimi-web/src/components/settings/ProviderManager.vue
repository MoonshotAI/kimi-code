<!-- apps/kimi-web/src/components/settings/ProviderManager.vue -->
<!-- Modal overlay for managing providers: list, add, refresh, delete. -->
<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '../../api/types';
import { PROVIDER_TYPES } from '../../lib/providerPresets';
import { useDialogFocus } from '../../composables/useDialogFocus';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Badge from '../ui/Badge.vue';
import Spinner from '../ui/Spinner.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const dialogRef = ref<HTMLElement | null>(null);
// Move focus into the dialog on open; restore it to the opener on close.
useDialogFocus(dialogRef);

const props = defineProps<{
  providers: AppProvider[];
  loading?: boolean;
  /** If true, providers could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
  /** When true, render the inner content without the Dialog overlay (for
   *  embedding inside a Settings tab). When false (default), keep the modal
   *  Dialog behavior used by App.vue's standalone provider-manager flow. */
  embedded?: boolean;
}>();

const emit = defineEmits<{
  add: [input: { type: string; apiKey?: string; baseUrl?: string; defaultModel?: string }];
  update: [id: string, input: { type?: string; apiKey?: string; baseUrl?: string; defaultModel?: string }];
  refresh: [id: string];
  delete: [id: string];
  close: [];
}>();

// -------------------------------------------------------------------------
// Delete confirmation
// -------------------------------------------------------------------------

// Delete — the modal confirm and the async delete live in App.vue
// (confirmDeleteProvider); the manager only emits the intent.
function onDeleteProvider(id: string): void {
  emit('delete', id);
}

// -------------------------------------------------------------------------
// Add-provider form
// -------------------------------------------------------------------------

const showAddForm = ref(false);
/** Non-null when editing an existing provider; null when adding new. */
const editingProviderId = ref<string | null>(null);
const addForm = reactive({
  type: 'moonshot',
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
});
const addError = ref('');

function openAdd(): void {
  editingProviderId.value = null;
  addForm.type = 'moonshot';
  addForm.apiKey = '';
  addForm.baseUrl = '';
  addForm.defaultModel = '';
  addError.value = '';
  showAddForm.value = true;
}

function openEdit(p: AppProvider): void {
  editingProviderId.value = p.id;
  // 编辑时用 provider id（即 UI 类型）填充表单，而不是 wire type（p.type）。
  addForm.type = p.id;
  addForm.apiKey = '';
  addForm.baseUrl = p.baseUrl ?? '';
  addForm.defaultModel = p.defaultModel ?? '';
  addError.value = '';
  showAddForm.value = true;
}

// 根据选中的类型自动填充 baseUrl 和 defaultModel
function onTypeChange(): void {
  const info = PROVIDER_TYPES.find((p) => p.value === addForm.type);
  if (info) {
    addForm.baseUrl = info.defaultUrl;
    addForm.defaultModel = info.defaultModel;
  }
}
function cancelAdd(): void {
  showAddForm.value = false;
  editingProviderId.value = null;
}
function submitAdd(): void {
  // Ollama / custom 等本地或自托管端点可能不需要 API key —— 由 preset 标记。
  const preset = PROVIDER_TYPES.find((p) => p.value === addForm.type);
  const apiKeyOptional = preset?.apiKeyOptional === true;
  if (!addForm.apiKey.trim() && !editingProviderId.value && !apiKeyOptional) {
    addError.value = t('providers.apiKeyRequired');
    return;
  }
  addError.value = '';
  if (editingProviderId.value) {
    const input: { type?: string; apiKey?: string; baseUrl?: string; defaultModel?: string } = {};
    if (addForm.type) input.type = addForm.type;
    if (addForm.apiKey.trim()) input.apiKey = addForm.apiKey.trim();
    if (addForm.baseUrl.trim()) input.baseUrl = addForm.baseUrl.trim();
    if (addForm.defaultModel.trim()) input.defaultModel = addForm.defaultModel.trim();
    emit('update', editingProviderId.value, input);
  } else {
    emit('add', {
      type: addForm.type,
      apiKey: addForm.apiKey.trim() || undefined,
      baseUrl: addForm.baseUrl.trim() || undefined,
      defaultModel: addForm.defaultModel.trim() || undefined,
    });
  }
  showAddForm.value = false;
  editingProviderId.value = null;
}

// -------------------------------------------------------------------------
// Keyboard — Esc closes
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (showAddForm.value) { cancelAdd(); return; }
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

// -------------------------------------------------------------------------
// Status helpers
// -------------------------------------------------------------------------

function statusColor(status: AppProvider['status']): string {
  if (status === 'connected') return 'var(--color-success)';
  if (status === 'error') return 'var(--color-danger)';
  return 'var(--color-text-faint)';
}
function statusLabel(status: AppProvider['status']): string {
  if (status === 'connected') return t('providers.status.connected');
  if (status === 'error') return t('providers.status.error');
  return t('providers.status.unconfigured');
}
</script>

<template>
  <component
    :is="embedded ? 'div' : Dialog"
    v-bind="embedded ? {} : { open: true, closeOnEsc: false, title: t('providers.title'), size: 'xl', height: 'fixed' }"
    v-on="embedded ? {} : { close: () => emit('close') }"
  >
    <div ref="dialogRef" class="pm" :class="{ 'pm-embedded': embedded }">
      <!-- Provider list -->
      <div class="prov-list">
        <!-- Loading state -->
        <div v-if="loading" class="state-row">
          <Spinner size="sm" />
          <span>{{ t('providers.loading') }}</span>
        </div>
        <!-- Unavailable (daemon 404) -->
        <div v-else-if="unavailable" class="state-row unavail">
          <Icon name="alert-triangle" size="md" />
          <span>{{ t('providers.unavailable') }}</span>
        </div>
        <!-- Empty -->
        <div v-else-if="providers.length === 0" class="empty">{{ t('providers.empty') }}</div>
        <!-- Provider rows -->
        <template v-else>
          <div v-for="p in providers" :key="p.id" class="prov-row">
            <!-- Status dot -->
            <Tooltip :text="statusLabel(p.status)">
              <span
                class="status-dot"
                :class="{ 'status-dot--empty': p.status !== 'connected' && p.status !== 'error' }"
                :style="p.status === 'connected' || p.status === 'error' ? { background: statusColor(p.status) } : undefined"
              />
            </Tooltip>
            <div class="prov-info">
              <span class="prov-type">{{ t('providers.types.' + p.id, p.id) }}</span>
              <span v-if="p.baseUrl" class="prov-url">{{ p.baseUrl }}</span>
              <span class="prov-meta">
                <Badge :variant="p.hasApiKey ? 'success' : 'neutral'" size="sm">
                  {{ p.hasApiKey ? t('providers.keySet') : t('providers.keyNotSet') }}
                </Badge>
                <span v-if="p.models && p.models.length > 0"> · {{ p.models.join(', ') }}</span>
              </span>
            </div>
            <!-- Actions -->
            <div class="prov-actions">
              <Tooltip :text="t('providers.editTitle', { type: t('providers.types.' + p.id, p.id) })">
                <Button variant="secondary" size="sm" @click="openEdit(p)">{{ t('common.edit') }}</Button>
              </Tooltip>
              <Tooltip :text="t('providers.refreshTitle', { type: t('providers.types.' + p.id, p.id) })">
                <Button variant="secondary" size="sm" @click="emit('refresh', p.id)">{{ t('providers.refresh') }}</Button>
              </Tooltip>
              <Tooltip :text="t('providers.deleteTitle', { type: t('providers.types.' + p.id, p.id) })">
                <Button variant="danger-soft" size="sm" @click="onDeleteProvider(p.id)">{{ t('providers.delete') }}</Button>
              </Tooltip>
            </div>
          </div>
        </template>
      </div>

      <!-- Add provider form / button -->
      <div v-if="!unavailable" class="add-section">
        <template v-if="!showAddForm">
            <div class="add-btns">
              <Button variant="primary" size="sm" @click="openAdd">
                <Icon name="plus" size="sm" />
                {{ t('providers.enterApiKey') }}
              </Button>
            </div>
        </template>
        <template v-else>
          <div class="add-form">
            <Field :label="t('providers.fieldType')">
              <Select v-model="addForm.type" :disabled="!!editingProviderId" @update:model-value="onTypeChange">
                <option v-for="pt in PROVIDER_TYPES" :key="pt.value" :value="pt.value">{{ t(pt.label) }}</option>
              </Select>
            </Field>
            <Field :label="t('providers.fieldApiKey')">
              <Input
                v-model="addForm.apiKey"
                type="password"
                :placeholder="editingProviderId ? t('providers.apiKeyOptional') : 'sk-…'"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
            <Field :label="t('providers.fieldBaseUrl')">
              <Input
                v-model="addForm.baseUrl"
                :placeholder="t('providers.baseUrlPlaceholder')"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
            <Field :label="t('providers.fieldDefaultModel')">
              <Input
                v-model="addForm.defaultModel"
                :placeholder="addForm.defaultModel || t('providers.baseUrlPlaceholder')"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
            <div v-if="addError" class="add-error">{{ addError }}</div>
            <div class="form-btns">
              <Button variant="primary" size="sm" @click="submitAdd">{{ editingProviderId ? t('common.save') : t('providers.add') }}</Button>
              <Button variant="secondary" size="sm" @click="cancelAdd">{{ t('common.cancel') }}</Button>
            </div>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div v-if="!embedded" class="footer-hint">{{ t('providers.escClose') }}</div>
    </div>
  </component>
</template>

<style scoped>
.pm { display: flex; flex-direction: column; gap: var(--space-4); }
/* Embedded (inside a Settings tab): no Dialog chrome, cap the list height so
   long provider rosters scroll within the panel instead of stretching it. */
.pm-embedded .prov-list { max-height: 50vh; overflow-y: auto; }

/* Provider list */
.prov-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.state-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.state-row.unavail { color: var(--color-warning); }
.empty {
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.prov-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-line);
  transition: background var(--duration-fast) var(--ease-out);
}
.prov-row:last-child { border-bottom: none; }

.status-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  box-sizing: border-box;
}
.status-dot--empty {
  background: transparent;
  border: 1.5px solid var(--color-text-faint);
}
.prov-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.prov-type {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.prov-url {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prov-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.prov-actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
  align-items: center;
  flex-wrap: wrap;
}
/* Add section */
.add-section {
  border-top: 1px solid var(--color-line);
  padding-top: var(--space-4);
}
.add-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Form */
.add-form { display: flex; flex-direction: column; gap: var(--space-3); }
.add-error {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-danger);
}
.form-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Footer */
.footer-hint {
  padding-top: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  border-top: 1px solid var(--color-line);
}

@media (max-width: 640px) {
  .prov-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .prov-actions {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
}
</style>
