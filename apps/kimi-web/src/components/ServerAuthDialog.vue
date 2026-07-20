<!-- apps/kimi-web/src/components/ServerAuthDialog.vue -->
<!-- Minimal token prompt shown when the Web UI has no server-transport
     credential, or when the server rejects it (HTTP 401). On submit we store
     the token as the bearer credential and reload so every REST/WS call picks
     it up. The overlay uses a tokened translucent backdrop and the card follows
     the unified v2 dialog look. -->
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { setCredential } from '../api/daemon/serverAuth';
import Button from './ui/Button.vue';
import Input from './ui/Input.vue';

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
  <div class="server-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="server-auth-title">
    <div class="server-auth-card">
      <div class="server-auth-head">
        <h1 id="server-auth-title" class="server-auth-title">Server token required</h1>
        <p class="server-auth-hint">
          This server is protected. Enter the bearer token printed when the server
          started (or the password set via <code>KIMI_CODE_PASSWORD</code>).
        </p>
      </div>
      <div class="server-auth-body">
        <Input
          ref="inputRef"
          v-model="credential"
          type="password"
          autocomplete="current-password"
          placeholder="Token"
          :disabled="submitting"
          @keydown="onKeydown"
        />
      </div>
      <div class="server-auth-foot">
        <Button
          variant="primary"
          :disabled="!credential || submitting"
          :loading="submitting"
          @click="submit"
        >
          {{ submitting ? 'Connecting…' : 'Connect' }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.server-auth-overlay {
  position: fixed;
  inset: 0;
  /* Above the connecting splash (--z-toast): on a 401 during first load the
     splash stays up, and this prompt must remain reachable on top of it. */
  z-index: var(--z-max);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-bg) 70%, transparent);
}

.server-auth-card {
  width: 480px;
  max-width: calc(100vw - 48px);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-ui);
}

.server-auth-head {
  display: flex;
  flex-direction: column;
  padding: 20px 22px 14px;
}

.server-auth-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.server-auth-hint {
  margin: 4px 0 0;
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

.server-auth-body {
  padding: 4px 22px 18px;
}

.server-auth-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px 20px;
}
</style>
