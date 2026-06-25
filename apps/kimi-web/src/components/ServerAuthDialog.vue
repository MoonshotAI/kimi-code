<!-- apps/kimi-web/src/components/ServerAuthDialog.vue -->
<!-- Minimal token prompt shown when the Web UI has no server-transport
     credential, or when the server rejects it (HTTP 401). On submit we store
     the token as the bearer credential and reload so every REST/WS call picks
     it up. The overlay is fully opaque so it covers the whole page (nothing
     underneath shows through). Light only, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { setCredential } from '../api/daemon/serverAuth';

const credential = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
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
      <h1 id="server-auth-title" class="server-auth-title">Server token required</h1>
      <p class="server-auth-hint">
        This server is protected. Enter the bearer token printed when the server
        started (or the password set via <code>KIMI_CODE_PASSWORD</code>).
      </p>
      <input
        ref="inputRef"
        v-model="credential"
        type="password"
        class="server-auth-input"
        autocomplete="current-password"
        placeholder="Token"
        :disabled="submitting"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="server-auth-button"
        :disabled="!credential || submitting"
        @click="submit"
      >
        {{ submitting ? 'Connecting…' : 'Connect' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.server-auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Fully opaque so the dialog covers the whole page — nothing underneath
     (e.g. the login page) shows through. */
  background: var(--bg, #ffffff);
  font-family: 'Inter', system-ui, sans-serif;
}

.server-auth-card {
  width: min(360px, calc(100vw - 32px));
  padding: 28px 28px 24px;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.server-auth-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}

.server-auth-hint {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.5;
  color: #555;
}

.server-auth-hint code {
  padding: 1px 5px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  background: #f0f0f0;
  border-radius: 4px;
}

.server-auth-input {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 14px;
  font-size: 14px;
  color: #1a1a1a;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 8px;
  outline: none;
}

.server-auth-input:focus {
  border-color: #1565c0;
  box-shadow: 0 0 0 3px rgba(21, 101, 192, 0.15);
}

.server-auth-button {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: #1565c0;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.server-auth-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.server-auth-button:not(:disabled):hover {
  background: #0d47a1;
}
</style>
