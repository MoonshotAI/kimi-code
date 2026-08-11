<!-- apps/web/src/components/settings/ProviderForm.vue -->
<!-- The shared vertical provider form of the Providers tab accordion: mode
     'add' (blank, footer = cancel + add) and mode 'edit' (prefilled, footer =
     delete + save with an inline delete-confirm bar; managed OAuth providers
     render read-only with an account-tab hint). One instance per expanded row
     so every row owns its form state; user input is reported upward as dirty
     so the parent can gate collapsing on the unsaved-changes guard. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '../../api/types';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import {
  buildAddProviderInput,
  buildUpdateProviderInput,
  emptyModelRow,
  isManagedOAuthProvider,
  PROVIDER_TYPES,
  providerModelRows,
  validateProviderForm,
  type ProviderFormState,
} from '../../lib/providerForm';
import { Banner, Button, Icon, IconButton, Input, Select } from '@moonshot-ai/app-ui';

const props = defineProps<{
  mode: 'add' | 'edit';
  provider?: AppProvider;
  /** Show the unsaved-changes guard bar at the top of the form. */
  guard?: boolean;
}>();

const emit = defineEmits<{
  dirtyChange: [dirty: boolean];
  guardStay: [];
  guardDiscard: [];
  added: [id: string];
  saved: [id: string];
  deleting: [];
  deleted: [id: string];
  cancel: [];
}>();

const { t } = useI18n();
const client = useKimiWebClient();

const form = reactive<ProviderFormState>({
  id: '',
  type: 'openai',
  apiKey: '',
  baseUrl: '',
  models: [emptyModelRow()],
});
const error = ref('');
const submitting = ref(false);
const confirmingDelete = ref(false);
const deleting = ref(false);

const adding = computed(() => props.mode === 'add');
const managed = computed(() => props.provider !== undefined && isManagedOAuthProvider(props.provider));

// The delete-confirm banner counts the PERSISTED models, not the form's
// unsaved rows (the user may have edited rows without saving).
const persistedModelCount = computed(() => {
  const p = props.provider;
  if (p === undefined) return 0;
  return providerModelRows(p, client.config.value?.models).length;
});

// A managed provider is read-only here, so with zero models the single blank
// row adds nothing — its disabled inputs show placeholder hints that read
// like real values. Show an explicit empty state instead.
const showModelsEmpty = computed(() => managed.value && persistedModelCount.value === 0);

const typeOptions = computed(() =>
  PROVIDER_TYPES.map((type) => ({ value: type, label: t(`providers.types.${type}`) })),
);

// The key can never be read back, so the placeholder carries the state:
// managed (OAuth, disabled), already set (type to replace), or a plain hint.
const apiKeyPlaceholder = computed(() => {
  if (managed.value) return t('providers.apiKeyManaged');
  if (!adding.value && props.provider?.hasApiKey === true) return t('providers.apiKeySet');
  return 'sk-…';
});

function fillForm(): void {
  error.value = '';
  confirmingDelete.value = false;
  const p = props.provider;
  if (adding.value || p === undefined) {
    form.id = '';
    form.type = 'openai';
    form.apiKey = '';
    form.baseUrl = '';
    form.models = [emptyModelRow()];
    return;
  }
  form.id = p.id;
  form.type = p.type;
  form.apiKey = '';
  form.baseUrl = p.baseUrl ?? '';
  const rows = providerModelRows(p, client.config.value?.models);
  form.models = rows.length > 0 ? rows : [emptyModelRow()];
}

onMounted(() => {
  fillForm();
  void loadApiKey();
});

// Prefill the stored key into the password field (edit only): the single GET
// is the one place the daemon reveals it. keyLoaded flips the blank-field
// semantics at save time from "keep" to "clear" (the input is authoritative
// once the user can see the real value). The prefill must never overwrite a
// key the user started typing while the GET was in flight — apiKeyTouched
// guards that race.
const keyLoaded = ref(false);
const apiKeyTouched = ref(false);
async function loadApiKey(): Promise<void> {
  const p = props.provider;
  if (adding.value || p === undefined || managed.value || p.hasApiKey !== true) return;
  try {
    const detail = await client.getProvider(p.id);
    if (apiKeyTouched.value) return;
    if (detail.apiKey !== undefined && detail.apiKey !== '') {
      form.apiKey = detail.apiKey;
      keyLoaded.value = true;
    }
  } catch {
    // The key stays empty and the "set — enter to replace" placeholder keeps
    // the state honest; saving still preserves the stored key.
  }
}

// Dirty = any USER input: native input events bubble up from the inputs, while
// programmatic v-model writes dispatch no events, so refills after a save stay
// clean. The custom Select emits no input event and marks dirty explicitly.
function markDirty(): void {
  emit('dirtyChange', true);
}

// The API key renders as a password field with a visibility toggle so users
// can double-check what they pasted; toggling is view-only, never dirty.
const showApiKey = ref(false);

// ---------------------------------------------------------------------------
// Submit (add / save)
// ---------------------------------------------------------------------------

// Surface a submit failure both in the banner and in view: the banner sits at
// the top of the form while the submit button is at the bottom, so without
// scrolling a failed add/save looks like a no-op.
const errorBox = ref<HTMLElement>();
function showError(message: string): void {
  error.value = message;
  void nextTick(() => errorBox.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  // The id is editable on the edit path too (renames go through PUT new_id).
  // apiKey/baseUrl are mandatory only when adding: on edit a blank key means
  // keep-or-clear (see keyLoaded) and a blank base URL means unset, so
  // providers without credentials (env-based) stay editable.
  const invalid = validateProviderForm(form, {
    requireApiKey: adding.value,
    requireBaseUrl: adding.value,
  });
  if (invalid !== null) {
    showError(t(`providers.error.${invalid}`));
    return;
  }
  error.value = '';
  submitting.value = true;
  try {
    if (adding.value) {
      const message = await client.addProvider(buildAddProviderInput(form));
      if (message !== null) {
        showError(message);
        return;
      }
      emit('dirtyChange', false);
      client.notify({ severity: 'success', title: t('providers.added') });
      emit('added', form.id.trim());
    } else {
      const p = props.provider;
      if (p === undefined) return;
      // The provider's configured default (raw config, alias form) — NOT the
      // catalog item's materialized default_model, which falls back to the
      // global default and would be persisted as provider-level by mistake.
      const configuredDefault = client.config.value?.providers?.[p.id]?.defaultModel;
      const message = await client.updateProvider(
        p.id,
        buildUpdateProviderInput(form, p, {
          includeBlankApiKey: keyLoaded.value,
          existingDefaultModel: configuredDefault,
        }),
      );
      if (message !== null) {
        showError(message);
        return;
      }
      // An edit can clear the global default (cleared_default) — re-read
      // auth/config state, mirroring handleUpdateConfig in App.vue.
      await client.checkAuth();
      // No refill: the form already holds exactly what was persisted, and a
      // refill blanks the key field for a beat (reads as a flash). The next
      // expand re-reads server state anyway.
      client.notify({ severity: 'success', title: t('providers.saved') });
      emit('dirtyChange', false);
      emit('saved', form.id.trim());
    }
  } finally {
    submitting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Delete (inline confirm bar, no modal)
// ---------------------------------------------------------------------------

async function confirmDelete(): Promise<void> {
  const p = props.provider;
  if (p === undefined || deleting.value) return;
  deleting.value = true;
  // Collapse first, then delete: the parent's leaving transition keeps this
  // form mounted for the animation, so the request only fires once the item
  // is visually closed — the row's removal from the reloaded list lands on a
  // zero-height item instead of tearing a 500px hole mid-list.
  emit('deleting');
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    // Resolves null on failure (already toasted by the composable).
    const result = await client.deleteProvider(p.id);
    if (result === null) {
      confirmingDelete.value = false;
      return;
    }
    emit('dirtyChange', false);
    emit('deleted', p.id);
  } finally {
    deleting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Model rows
// ---------------------------------------------------------------------------

function addModelRow(): void {
  form.models.push(emptyModelRow());
  markDirty();
}

function removeModelRow(index: number): void {
  // The form always keeps at least one model row (server requires >= 1).
  if (form.models.length <= 1) return;
  form.models.splice(index, 1);
  markDirty();
}
</script>

<template>
  <div class="pf-form" @input="markDirty">
    <!-- Unsaved-changes guard (inserted by the parent on collapse attempts) -->
    <Banner v-if="guard" variant="warning" class="pf-guard">
      <span class="msg">{{ t('providers.unsavedGuard') }}</span>
      <Button variant="secondary" size="sm" @click="emit('guardStay')">{{ t('providers.guardStay') }}</Button>
      <Button variant="danger" size="sm" @click="emit('guardDiscard')">{{ t('providers.guardDiscard') }}</Button>
    </Banner>

    <div v-if="error" ref="errorBox">
      <Banner variant="danger">{{ error }}</Banner>
    </div>

    <div class="pf-field">
      <label class="pf-field-label">{{ t('providers.fieldId') }}<span class="req"> *</span></label>
      <Input
        v-model="form.id"
        placeholder="my-openai"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="pf-field">
      <label class="pf-field-label">{{ t('providers.fieldType') }}<span class="req"> *</span></label>
      <Select
        :model-value="form.type"
        :options="typeOptions"
        :disabled="managed"
        @update:model-value="form.type = $event; markDirty()"
      />
    </div>
    <div class="pf-field">
      <label class="pf-field-label">{{ t('providers.fieldApiKey') }}<span class="req"> *</span></label>
      <div class="pf-key-wrap">
        <Input
          v-model="form.apiKey"
          :type="showApiKey ? 'text' : 'password'"
          :placeholder="apiKeyPlaceholder"
          :disabled="managed"
          autocomplete="off"
          spellcheck="false"
          @input="apiKeyTouched = true"
        />
        <IconButton
          v-if="!managed"
          class="pf-key-eye"
          size="sm"
          :label="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
          :tooltip="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
          @click="showApiKey = !showApiKey"
        >
          <Icon :name="showApiKey ? 'eye-off' : 'eye'" size="sm" />
        </IconButton>
      </div>
    </div>
    <div class="pf-field">
      <label class="pf-field-label">{{ t('providers.fieldBaseUrl') }}<span class="req"> *</span></label>
      <Input
        v-model="form.baseUrl"
        :placeholder="t('providers.baseUrlPlaceholder')"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="pf-field">
      <label class="pf-field-label">{{ t('providers.fieldModels') }}<span class="req"> *</span></label>
      <div class="pf-models">
        <div v-if="showModelsEmpty" class="pf-models-empty">{{ t('providers.noModels') }}</div>
        <template v-else>
        <div class="pf-model-grid pf-model-head">
          <span>{{ t('providers.colModelId') }}<span class="req"> *</span></span>
          <span>{{ t('providers.colContext') }}<span class="req"> *</span></span>
          <span>{{ t('providers.colDisplayName') }}</span>
          <span />
        </div>
        <div v-for="(row, index) in form.models" :key="index" class="pf-model-grid">
          <Input
            v-model="row.model"
            :placeholder="t('providers.modelIdPlaceholder')"
            :disabled="managed"
            autocomplete="off"
            spellcheck="false"
          />
          <Input
            v-model="row.maxContextSize"
            inputmode="numeric"
            :placeholder="t('providers.modelContextPlaceholder')"
            :disabled="managed"
            autocomplete="off"
            spellcheck="false"
          />
          <Input
            v-model="row.displayName"
            :placeholder="t('providers.modelNamePlaceholder')"
            :disabled="managed"
            autocomplete="off"
            spellcheck="false"
          />
          <IconButton
            v-if="!managed"
            size="sm"
            :label="t('providers.removeModel')"
            :tooltip="t('providers.removeModel')"
            :disabled="form.models.length <= 1"
            @click="removeModelRow(index)"
          >
            <Icon name="trash" size="sm" />
          </IconButton>
          <span v-else />
        </div>
        <div v-if="!managed">
          <Button variant="ghost" size="sm" @click="addModelRow">
            <Icon name="plus" size="sm" />
            {{ t('providers.addModel') }}
          </Button>
        </div>
        </template>
      </div>
    </div>

    <!-- Footer: three states -->
    <div class="pf-foot">
      <!-- Managed OAuth: login/logout lives on the account tab -->
      <span v-if="managed" class="pf-managed-note">{{ t('providers.managedHint') }}</span>

      <!-- Add -->
      <template v-else-if="adding">
        <Button variant="secondary" size="sm" @click="emit('cancel')">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="primary" size="sm" :disabled="submitting" @click="submit">
          {{ t('providers.addProvider') }}
        </Button>
      </template>

      <!-- Edit: inline delete-confirm bar replaces the buttons -->
      <template v-else-if="confirmingDelete && props.provider !== undefined">
        <span class="pf-confirm-msg">
          {{ t('providers.deleteConfirm', { id: props.provider.id, count: persistedModelCount }) }}
        </span>
        <span class="spacer" />
        <Button variant="secondary" size="sm" :disabled="deleting" @click="confirmingDelete = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" size="sm" :disabled="deleting" @click="confirmDelete">
          {{ t('providers.deleteConfirmYes') }}
        </Button>
      </template>
      <template v-else>
        <Button variant="danger-soft" size="sm" @click="confirmingDelete = true">
          {{ t('providers.deleteProvider') }}
        </Button>
        <span class="spacer" />
        <Button variant="primary" size="sm" :disabled="submitting" @click="submit">
          {{ t('providers.save') }}
        </Button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pf-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-4) var(--space-5);
  border-top: 0.5px solid var(--color-line);
}

/* The guard bar's buttons align right inside the banner's text slot. */
.pf-guard :deep(.ui-banner__text) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}
.pf-guard .msg { flex: 1; }

.pf-field { display: flex; flex-direction: column; gap: 6px; }
.pf-key-wrap { position: relative; }
.pf-key-wrap :deep(.ui-input) { padding-right: calc(var(--icon-button-sm) + var(--space-2)); }
.pf-key-eye { position: absolute; right: var(--space-1); top: 50%; transform: translateY(-50%); }
/* Same label styling as app-ui's Field, plus a required marker. */
.pf-field-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.req { color: var(--color-danger); }

.pf-models { display: flex; flex-direction: column; gap: var(--space-2); }
.pf-model-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr) auto;
  gap: var(--space-2);
  align-items: center;
}
.pf-model-head span {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.pf-models-empty {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}

.pf-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-4);
  border-top: 0.5px solid var(--color-line);
}
.pf-foot .spacer { flex: 1; }
.pf-confirm-msg {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-danger);
}
.pf-managed-note {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}

@media (max-width: 640px) {
  .pf-model-grid { grid-template-columns: minmax(0, 1fr) auto; }
}
</style>
