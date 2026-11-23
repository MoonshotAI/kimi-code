<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Card, Link } from '@moonshot-ai/app-ui';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { chatMcpOpenBlocked, hasChatMcpDesktopOpener, openChatMcpAuthorization } from '@moonshot-ai/app-client/composables';

const props = defineProps<{ tool: ToolCall }>();
const { t } = useI18n();
const card = computed(() => props.tool.mcpAuth);
const request = computed(() => card.value?.phase === 'waiting' ? card.value.request : undefined);
const expired = ref(false);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
watch(request, (current, _, onCleanup) => {
  copyState.value = 'idle';
  expired.value = current !== undefined && current.expiresAt <= Date.now();
  if (!current || expired.value) return;
  const timer = setTimeout(() => { expired.value = true; }, current.expiresAt - Date.now());
  onCleanup(() => clearTimeout(timer));
}, { immediate: true });
const phase = computed(() => expired.value ? 'expired' : card.value?.phase);
const active = computed(() => expired.value ? undefined : request.value);
const serverLabel = computed(() => card.value?.serverName.replace(/^plugin-[^:]+:/u, ''));

function openPage(event: MouseEvent) {
  const current = active.value;
  if (!current || current.expiresAt <= Date.now()) {
    event.preventDefault();
    return;
  }
  if (hasChatMcpDesktopOpener()) {
    event.preventDefault();
    void openChatMcpAuthorization(current);
  } else if (event.currentTarget instanceof HTMLButtonElement) {
    window.open(current.authorizationUrl, '_blank', 'noopener,noreferrer');
  }
}

async function copyLink() {
  const current = active.value;
  if (!current || current.expiresAt <= Date.now()) return;
  const ok = await copyTextToClipboard(current.authorizationUrl);
  if (active.value === current) copyState.value = ok ? 'copied' : 'failed';
}
</script>

<template>
  <Card v-if="card" class="mcp-auth-card" :size="active ? 'md' : 'sm'">
    <div class="mcp-auth-status" role="status">
      {{ t(`tools.mcpAuth.${phase}`, { server: serverLabel }) }}
    </div>
    <template v-if="active">
      <div class="mcp-auth-url" dir="ltr">
        <Link :href="active.authorizationUrl" variant="muted" external @click="openPage">{{ active.authorizationUrl }}</Link>
      </div>
      <p v-if="chatMcpOpenBlocked(active.waitId)" class="mcp-auth-notice" role="alert">{{ t('tools.mcpAuth.blocked') }}</p>
    </template>
    <template v-if="active" #foot>
      <Button variant="primary" size="xs" @click="openPage">{{ t('tools.mcpAuth.open') }}</Button>
      <Button variant="text" size="xs" @click="copyLink">
        <span aria-live="polite">{{ t(copyState === 'copied' ? 'login.copied' : 'login.copyLink') }}</span>
      </Button>
      <span v-if="copyState === 'failed'" class="mcp-auth-notice" role="alert">{{ t('remoteControl.copyFailed') }}</span>
    </template>
  </Card>
</template>

<style scoped>
.mcp-auth-card { min-width: 0; margin-block: var(--space-2); }
.mcp-auth-status { font-size: var(--text-base); font-weight: var(--weight-medium); color: var(--color-text); }
.mcp-auth-url { margin-top: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--color-fill-1); font: var(--text-sm)/var(--leading-normal) var(--font-mono); overflow-wrap: anywhere; user-select: text; }
.mcp-auth-card :deep(.ui-card__foot) { justify-content: flex-start; flex-wrap: wrap; gap: var(--space-3); font-size: var(--text-xs); }
.mcp-auth-notice { margin: var(--space-2) 0 0; font-size: var(--text-sm); color: var(--color-text-muted); }
</style>
