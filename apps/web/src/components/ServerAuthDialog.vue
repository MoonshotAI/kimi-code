<!-- Minimal token prompt shown when the Web UI has no server-transport
     credential, or when the server rejects it (HTTP 401). On submit we store
     the token as the bearer credential and reload so every REST/WS call picks
     it up. Rendered through the canonical Dialog; it cannot be dismissed —
     the only way out is a valid token. -->
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { setCredential } from '@moonshot-ai/app-core/lib';
import { Button, Dialog, Input } from '@moonshot-ai/app-ui';

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
  // Reload so the HTTP client and WebSocket reconnect with the new credential.
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
    title="Server token required"
    :hide-close="true"
    :close-on-overlay="false"
    :close-on-esc="false"
  >
    <p class="server-auth-hint">
      This server is protected. Enter the bearer token printed when the server
      started (or the password set via <code>KIMI_CODE_PASSWORD</code>).
    </p>
    <Input
      ref="inputRef"
      v-model="credential"
      type="password"
      autocomplete="current-password"
      placeholder="Token"
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
        {{ submitting ? 'Connecting…' : 'Connect' }}
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
