<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { setCredential } from '@moonshot-ai/app-core/lib';
import { Button, Dialog, Input } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const credential = ref('');
const inputRef = ref<InstanceType<typeof Input> | null>(null);
const submitting = ref(false);

onMounted(() => {
  void nextTick(() => inputRef.value?.focus());
});

function submit(): void {
  const value = credential.value;
  if (!value || submitting.value) return;
  submitting.value = true;
  setCredential(value);
  const bridge = (
    window as { kimiDesktop?: { updateServerCredential?: (token: string) => Promise<void> } }
  ).kimiDesktop;
  void bridge?.updateServerCredential?.(value);
  window.location.reload();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <Dialog
    :open="true"
    :title="t('serverAuth.title')"
    :hide-close="true"
    :close-on-overlay="false"
    :close-on-esc="false"
  >
    <i18n-t keypath="serverAuth.hint" tag="p" class="server-auth-hint">
      <template #env><code>KIMI_CODE_PASSWORD</code></template>
    </i18n-t>
    <Input
      ref="inputRef"
      v-model="credential"
      type="password"
      autocomplete="current-password"
      :placeholder="t('serverAuth.tokenPlaceholder')"
      :disabled="submitting"
      @keydown="onKeydown"
    />
    <template #foot>
      <Button
        variant="primary"
        :disabled="!credential || submitting"
        :loading="submitting"
        @click="submit"
      >
        {{ submitting ? t('serverAuth.connecting') : t('serverAuth.connect') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.server-auth-hint {
  margin: 0 0 var(--space-3);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
.server-auth-hint code {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--color-surface-sunken);
  border-radius: var(--radius-xs);
}
</style>
