<script setup lang="ts">
import { ref } from 'vue';
import { Button } from '@moonshot-ai/web-ui';
import { useIsDark } from '@moonshot-ai/web-core';
// Inlined at build time by unplugin-icons from the shared `kimi` collection
// (see vite.renderer.config.ts `iconsDir`). Exercises the preset's icon loader
// so a misconfigured iconsDir fails the build rather than shipping a broken UI.
import IconSearch from '~icons/kimi/search';

type DesktopBridge = {
  getServerToken: () => Promise<string | undefined>;
};

const isDark = useIsDark();
const ipcStatus = ref('idle');

async function pingIpc(): Promise<void> {
  const bridge = (window as unknown as { kimiDesktop?: DesktopBridge }).kimiDesktop;
  if (bridge === undefined) {
    ipcStatus.value = 'kimiDesktop bridge missing';
    return;
  }
  const token = await bridge.getServerToken();
  ipcStatus.value = token === undefined ? 'IPC ok · no token' : `IPC ok · token ${token.length} chars`;
}
</script>

<template>
  <main class="desktop-placeholder" :data-color-scheme="isDark ? 'dark' : 'light'">
    <h1>Kimi Code Desktop</h1>
    <p class="hint">
      Renderer placeholder (Task 4.4). Theme:
      <strong>{{ isDark ? 'dark' : 'light' }}</strong>
    </p>
    <Button variant="primary" @click="pingIpc">
      <IconSearch aria-hidden="true" />
      Ping IPC
    </Button>
    <p class="status">{{ ipcStatus }}</p>
  </main>
</template>

<style scoped>
.desktop-placeholder {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-6);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-ui);
}
.desktop-placeholder h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
}
.hint,
.status {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.status {
  font-family: var(--font-mono);
}
</style>
