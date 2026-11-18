<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Input } from '@moonshot-ai/app-ui';
import type { RuntimeEnvironmentKey, RuntimeEnvironmentOverrides } from '../../../shared/runtime-environment';
import { runtimeEnvironmentBridge } from '../../lib/runtimeEnvironment';

const props = defineProps<{
  overrides: RuntimeEnvironmentOverrides;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const draft = ref<RuntimeEnvironmentOverrides>({ ...props.overrides });
const busy = ref(false);
const invalidField = ref<RuntimeEnvironmentKey | null>(null);
const generalError = ref('');
const homeInput = ref<InstanceType<typeof Input> | null>(null);

const fields: Array<{ key: RuntimeEnvironmentKey; labelKey: string; inputMode: 'text' | 'url' }> = [
  { key: 'KIMI_CODE_HOME', labelKey: 'settings.runtimeEnvironmentHome', inputMode: 'text' },
  { key: 'KIMI_CODE_OAUTH_HOST', labelKey: 'settings.runtimeEnvironmentOauthHost', inputMode: 'url' },
  { key: 'KIMI_CODE_BASE_URL', labelKey: 'settings.runtimeEnvironmentBaseUrl', inputMode: 'url' },
  { key: 'KIMI_CODE_REMOTE_CONTROL_RELAY_URL', labelKey: 'settings.runtimeEnvironmentRelayUrl', inputMode: 'url' },
];

watch(draft, () => {
  invalidField.value = null;
  generalError.value = '';
}, { deep: true });

function close(): void {
  if (!busy.value) emit('close');
}

function failure(result: { status: string; field?: RuntimeEnvironmentKey; error?: string }, reset: boolean): void {
  busy.value = false;
  if (result.status === 'cancelled') return;
  if (result.status === 'invalid' && result.field !== undefined) {
    invalidField.value = result.field;
  } else if (result.status === 'unavailable') {
    generalError.value = t('settings.runtimeEnvironmentUnavailable');
  } else {
    generalError.value = result.error ?? t(reset ? 'settings.runtimeEnvironmentResetFailed' : 'settings.runtimeEnvironmentSaveFailed');
  }
}

async function onSave(): Promise<void> {
  const bridge = runtimeEnvironmentBridge();
  if (busy.value || bridge?.saveRuntimeEnvironmentOverrides === undefined) return;
  busy.value = true;
  invalidField.value = null;
  generalError.value = '';
  try {
    const result = await bridge.saveRuntimeEnvironmentOverrides({ ...draft.value });
    if (result.status !== 'relaunching') failure(result, false);
  } catch (error) {
    failure({ status: 'error', error: error instanceof Error ? error.message : String(error) }, false);
  }
}

async function onReset(): Promise<void> {
  const bridge = runtimeEnvironmentBridge();
  if (busy.value || bridge?.resetRuntimeEnvironmentOverrides === undefined) return;
  busy.value = true;
  invalidField.value = null;
  generalError.value = '';
  try {
    const result = await bridge.resetRuntimeEnvironmentOverrides();
    if (result.status !== 'relaunching') failure(result, true);
  } catch (error) {
    failure({ status: 'error', error: error instanceof Error ? error.message : String(error) }, true);
  }
}
</script>

<template>
  <Dialog
    :open="true"
    :title="t('settings.runtimeEnvironmentTitle')"
    :description="t('settings.runtimeEnvironmentDescription')"
    :close-on-overlay="false"
    :initial-focus="() => homeInput?.el ?? null"
    size="md"
    @close="close"
  >
    <form class="runtime-environment-form" method="post" @submit.prevent="onSave">
      <div class="runtime-environment-fields">
        <div v-for="field in fields" :key="field.key" class="runtime-environment-field">
          <label :for="`runtime-environment-${field.key}`">
            {{ t(field.labelKey) }}<span v-if="field.key !== 'KIMI_CODE_HOME'" class="runtime-environment-required" aria-hidden="true">*</span>
          </label>
          <Input
            :id="`runtime-environment-${field.key}`"
            :ref="field.key === 'KIMI_CODE_HOME' ? 'homeInput' : undefined"
            v-model="draft[field.key]"
            :name="field.key"
            type="text"
            :inputmode="field.inputMode"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            :required="field.key !== 'KIMI_CODE_HOME'"
            :disabled="busy"
            :error="invalidField === field.key"
            :aria-invalid="invalidField === field.key"
            :aria-errormessage="invalidField === field.key ? `runtime-environment-error-${field.key}` : undefined"
          />
          <span
            v-if="invalidField === field.key"
            :id="`runtime-environment-error-${field.key}`"
            class="runtime-environment-error"
            role="alert"
          >
            {{ t(field.key === 'KIMI_CODE_HOME' ? 'settings.runtimeEnvironmentInvalidHome' : 'settings.runtimeEnvironmentInvalidUrl') }}
          </span>
        </div>
      </div>
      <p v-if="generalError" class="runtime-environment-error" role="alert">{{ generalError }}</p>
      <div class="runtime-environment-actions">
        <Button variant="secondary" type="button" :disabled="busy" @click="onReset">
          {{ t('settings.runtimeEnvironmentReset') }}
        </Button>
        <Button variant="primary" type="submit" :loading="busy" :disabled="busy">
          {{ t('settings.runtimeEnvironmentSave') }}
        </Button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.runtime-environment-form,
.runtime-environment-fields {
  display: grid;
  gap: var(--space-4);
}
.runtime-environment-field {
  display: grid;
  gap: var(--space-2);
}
.runtime-environment-field label {
  color: var(--color-text-strong);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.runtime-environment-required {
  margin-inline-start: 2px;
  color: var(--color-danger);
}
.runtime-environment-error {
  margin: 0;
  color: var(--color-danger);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.runtime-environment-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
</style>
