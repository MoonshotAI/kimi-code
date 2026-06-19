<!-- apps/kimi-web/src/components/ProviderManager.vue -->
<!-- Modal overlay for managing providers: list, add, refresh, delete. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '../api/types';
import { useDialogFocus } from '../composables/useDialogFocus';

const { t } = useI18n();

const dialogRef = ref<HTMLElement | null>(null);
// Move focus into the dialog on open; restore it to the opener on close.
useDialogFocus(dialogRef);

const props = defineProps<{
  providers: AppProvider[];
  loading?: boolean;
  /** If true, providers could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
}>();

const emit = defineEmits<{
  add: [input: { type: string; apiKey?: string; baseUrl?: string; defaultModel?: string }];
  refresh: [id: string];
  delete: [id: string];
  /** Open the login dialog for the given platform (OAuth flow) */
  openLogin: [platform: string];
  close: [];
}>();

// -------------------------------------------------------------------------
// Delete confirmation
// -------------------------------------------------------------------------

const confirmDeleteId = ref<string | null>(null);

function askDelete(id: string): void {
  confirmDeleteId.value = id;
}
function confirmDelete(): void {
  if (confirmDeleteId.value) {
    emit('delete', confirmDeleteId.value);
    confirmDeleteId.value = null;
  }
}
function cancelDelete(): void {
  confirmDeleteId.value = null;
}

// -------------------------------------------------------------------------
// Add-provider form
// -------------------------------------------------------------------------

const showAddForm = ref(false);
const addForm = reactive({
  type: 'moonshot',
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
});
const addError = ref('');

const PROVIDER_TYPES = ['moonshot', 'anthropic', 'openai', 'custom'];

function openAdd(): void {
  addForm.type = 'moonshot';
  addForm.apiKey = '';
  addForm.baseUrl = '';
  addForm.defaultModel = '';
  addError.value = '';
  showAddForm.value = true;
}
function cancelAdd(): void {
  showAddForm.value = false;
}
function submitAdd(): void {
  if (!addForm.apiKey.trim()) {
    addError.value = t('providers.apiKeyRequired');
    return;
  }
  addError.value = '';
  emit('add', {
    type: addForm.type,
    apiKey: addForm.apiKey.trim() || undefined,
    baseUrl: addForm.baseUrl.trim() || undefined,
    defaultModel: addForm.defaultModel.trim() || undefined,
  });
  showAddForm.value = false;
}

// -------------------------------------------------------------------------
// Keyboard — Esc closes
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (showAddForm.value) { cancelAdd(); return; }
    if (confirmDeleteId.value) { cancelDelete(); return; }
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

// -------------------------------------------------------------------------
// Status helpers
// -------------------------------------------------------------------------

function statusColor(status: AppProvider['status']): string {
  if (status === 'connected') return 'var(--ok)';
  if (status === 'error') return 'var(--err)';
  return 'var(--faint)';
}
function statusLabel(status: AppProvider['status']): string {
  if (status === 'connected') return t('providers.status.connected');
  if (status === 'error') return t('providers.status.error');
  return t('providers.status.unconfigured');
}
</script>

<template>
  <!-- Backdrop -->
  <div class="backdrop" @click.self="emit('close')">
    <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-label="t('providers.dialogLabel')">

      <!-- Header -->
      <div class="dh">
        <span class="dtitle">{{ t('providers.title') }}</span>
        <button class="close-btn" :title="t('providers.close')" @click="emit('close')">✕</button>
      </div>

      <!-- Provider list -->
      <div class="prov-list">
        <!-- Loading state -->
        <div v-if="loading" class="state-row">
          <svg class="spin-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--blue)" stroke-width="1.5">
            <circle cx="7" cy="7" r="5" stroke-dasharray="20 12" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="1s" repeatCount="indefinite"/>
            </circle>
          </svg>
          <span>{{ t('providers.loading') }}</span>
        </div>
        <!-- Unavailable (daemon 404) -->
        <div v-else-if="unavailable" class="state-row unavail">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--warn)" stroke-width="1.5">
            <path d="M8 1.5 L15.5 14.5 H0.5 Z"/>
            <line x1="8" y1="7" x2="8" y2="10.5"/>
            <circle cx="8" cy="12.5" r="0.7" fill="var(--warn)"/>
          </svg>
          <span>{{ t('providers.unavailable') }}</span>
        </div>
        <!-- Empty -->
        <div v-else-if="providers.length === 0" class="empty">{{ t('providers.empty') }}</div>
        <!-- Provider rows -->
        <template v-else>
          <div v-for="p in providers" :key="p.id" class="prov-row">
            <!-- Status dot -->
            <span class="status-dot" :style="{ color: statusColor(p.status) }" :title="statusLabel(p.status)">
              <svg v-if="p.status === 'connected'" width="8" height="8" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="3.5" :fill="statusColor(p.status)"/>
              </svg>
              <svg v-else-if="p.status === 'error'" width="8" height="8" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="3.5" :fill="statusColor(p.status)"/>
              </svg>
              <svg v-else width="8" height="8" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="3" fill="none" stroke="var(--faint)" stroke-width="1"/>
              </svg>
            </span>
            <div class="prov-info">
              <span class="prov-type">{{ p.type }}</span>
              <span v-if="p.baseUrl" class="prov-url">{{ p.baseUrl }}</span>
              <span class="prov-meta">
                <span class="prov-key-state" :class="p.hasApiKey ? 'has-key' : 'no-key'">
                  {{ p.hasApiKey ? t('providers.keySet') : t('providers.keyNotSet') }}
                </span>
                <span v-if="p.models && p.models.length > 0"> · {{ t('providers.modelCount', { count: p.models.length }) }}</span>
              </span>
            </div>
            <!-- Actions -->
            <div v-if="confirmDeleteId === p.id" class="confirm-row">
              <span class="confirm-text">{{ t('providers.confirmDelete') }}</span>
              <button class="act-btn danger" @click="confirmDelete">{{ t('providers.confirm') }}</button>
              <button class="act-btn" @click="cancelDelete">{{ t('providers.cancel') }}</button>
            </div>
            <div v-else class="prov-actions">
              <button class="act-btn" :title="t('providers.refreshTitle', { type: p.type })" @click="emit('refresh', p.id)">{{ t('providers.refresh') }}</button>
              <button class="act-btn danger" :title="t('providers.deleteTitle', { type: p.type })" @click="askDelete(p.id)">{{ t('providers.delete') }}</button>
            </div>
          </div>
        </template>
      </div>

      <!-- Add provider form / button -->
      <div v-if="!unavailable" class="add-section">
        <template v-if="!showAddForm">
          <div class="add-btns">
            <!-- OAuth login shortcuts for common platforms -->
            <button class="add-btn-oauth" @click="emit('openLogin', 'moonshot')">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="5" cy="3" r="2"/><path d="M1 9c0-2.2 1.8-4 4-4s4 1.8 4 4"/>
              </svg>
              {{ t('providers.loginKimi') }}
            </button>
            <button class="add-btn-oauth" @click="emit('openLogin', 'anthropic')">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="5" cy="3" r="2"/><path d="M1 9c0-2.2 1.8-4 4-4s4 1.8 4 4"/>
              </svg>
              {{ t('providers.loginAnthropic') }}
            </button>
            <button class="add-btn add-btn-key" @click="openAdd">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
                <line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/>
              </svg>
              {{ t('providers.enterApiKey') }}
            </button>
          </div>
        </template>
        <template v-else>
          <div class="add-form">
            <div class="form-row">
              <label class="flabel">{{ t('providers.fieldType') }}</label>
              <select v-model="addForm.type" class="finput fselect">
                <option v-for="t in PROVIDER_TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>
            <div class="form-row">
              <label class="flabel">{{ t('providers.fieldApiKey') }}</label>
              <input
                v-model="addForm.apiKey"
                class="finput"
                type="password"
                placeholder="sk-…"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="form-row">
              <label class="flabel">{{ t('providers.fieldBaseUrl') }}</label>
              <input
                v-model="addForm.baseUrl"
                class="finput"
                type="text"
                :placeholder="t('providers.baseUrlPlaceholder')"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="form-row">
              <label class="flabel">{{ t('providers.fieldDefaultModel') }}</label>
              <input
                v-model="addForm.defaultModel"
                class="finput"
                type="text"
                :placeholder="t('providers.optional')"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div v-if="addError" class="add-error">{{ addError }}</div>
            <div class="form-btns">
              <button class="act-btn primary" @click="submitAdd">{{ t('providers.add') }}</button>
              <button class="act-btn" @click="cancelAdd">{{ t('providers.cancel') }}</button>
            </div>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div class="footer-hint">{{ t('providers.escClose') }}</div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 23, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.dialog {
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  width: 580px;
  max-width: calc(100vw - 32px);
  height: 520px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
}

.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.dtitle {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 700;
  color: var(--ink);
  flex: 1;
  letter-spacing: 0.02em;
}
.close-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: var(--ui-font-size);
  padding: 2px 4px;
  line-height: 1;
}
.close-btn:hover { color: var(--ink); }

/* Provider list */
.prov-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  min-height: 60px;
}
.state-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 14px;
  color: var(--dim);
  font-size: var(--ui-font-size);
}
.state-row.unavail { color: var(--warn); }
.empty {
  padding: 20px 14px;
  color: var(--muted);
  font-size: var(--ui-font-size);
}
.prov-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line2);
}
.prov-row:last-child { border-bottom: none; }

.status-dot {
  width: 10px;
  height: 10px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.prov-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.prov-type {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 600;
  color: var(--ink);
}
.prov-url {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prov-meta {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--dim);
}
.prov-key-state {
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  padding: 1px 5px;
  border-radius: 3px;
}
.prov-key-state.has-key { background: color-mix(in srgb, var(--ok) 9%, var(--bg)); color: var(--ok); }
.prov-key-state.no-key { background: var(--line2); color: var(--muted); }

.prov-actions, .confirm-row {
  display: flex;
  gap: 6px;
  flex: none;
  align-items: center;
}
.confirm-text {
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--err);
}

/* Add section */
.add-section {
  border-top: 1px solid var(--line);
  padding: 10px 14px;
}
.add-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.add-btn-oauth {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--soft);
  border: 1px solid var(--bd);
  border-radius: 3px;
  color: var(--blue);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 5px 12px;
  cursor: pointer;
}
.add-btn-oauth:hover { background: var(--bd); }
.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 1px dashed var(--line);
  border-radius: 3px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 5px 12px;
  cursor: pointer;
}
.add-btn:hover { background: var(--panel2); color: var(--text); }
.add-btn-key { /* inherits from .add-btn */ }

/* Form */
.add-form { display: flex; flex-direction: column; gap: 8px; }
.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.flabel {
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--dim);
  width: 70px;
  flex: none;
  text-align: right;
}
.finput {
  flex: 1;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.finput:focus-visible {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 25%, transparent);
}

.fselect { cursor: pointer; }
.add-error {
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--err);
  padding-left: 80px;
}
.form-btns {
  display: flex;
  gap: 8px;
  padding-left: 80px;
}

/* Buttons */
.act-btn {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  padding: 3px 10px;
  cursor: pointer;
  color: var(--text);
}
.act-btn:hover { background: var(--panel2); }
.act-btn.danger { color: var(--err); }
.act-btn.danger:hover { background: color-mix(in srgb, var(--err) 5%, var(--bg)); border-color: var(--err); }
.act-btn.primary {
  background: var(--blue);
  border-color: var(--blue);
  color: var(--bg);
}
.act-btn.primary:hover { background: var(--blue2); }

/* Footer */
.footer-hint {
  padding: 6px 14px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
  border-radius: 0 0 4px 4px;
}

@media (max-width: 640px) {
  .backdrop {
    align-items: stretch;
    padding:
      max(12px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .dialog {
    width: 100%;
    max-width: none;
    height: auto;
    max-height: calc(100dvh - 24px);
  }
  .prov-row {
    align-items: flex-start;
    flex-wrap: wrap;
    min-height: 48px;
  }
  .prov-actions,
  .confirm-row {
    flex: 1 1 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .form-row {
    align-items: stretch;
    flex-direction: column;
    gap: 5px;
  }
  .flabel {
    width: auto;
    text-align: left;
  }
  .add-error,
  .form-btns {
    padding-left: 0;
  }
  .form-btns {
    flex-wrap: wrap;
  }
  .act-btn {
    min-height: 34px;
  }
}
</style>
