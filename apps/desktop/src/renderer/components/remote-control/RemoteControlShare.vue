<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, IconButton } from '@moonshot-ai/app-ui';

import { createRemoteControlQrDataUrl } from '../../lib/remoteControlQr';
import { track } from '../../lib/track';

const props = defineProps<{
  url: string;
  source: 'panel' | 'conflict_dialog';
  compact?: boolean;
}>();

const { t } = useI18n();
const qrDataUrl = ref<string | undefined>(undefined);
const qrOpen = ref(false);
const copied = ref(false);
const copyFailed = ref(false);
let qrGeneration = 0;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.url,
  async (url) => {
    const generation = ++qrGeneration;
    qrDataUrl.value = undefined;
    const next = await createRemoteControlQrDataUrl(url);
    if (generation === qrGeneration) qrDataUrl.value = next;
  },
  { immediate: true },
);

async function copyLink(): Promise<void> {
  copyFailed.value = false;
  const ok = await copyTextToClipboard(props.url);
  if (!ok) {
    copyFailed.value = true;
    track('remote_control_action', { action: 'copy_link', source: props.source, outcome: 'error' });
    return;
  }
  track('remote_control_action', { action: 'copy_link', source: props.source, outcome: 'ok' });
  copied.value = true;
  if (copiedTimer !== undefined) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
    copiedTimer = undefined;
  }, 2000);
}

function openRemotePage(): void {
  track('remote_control_action', { action: 'open_link', source: props.source });
  window.open(props.url, '_blank', 'noopener,noreferrer');
}

onBeforeUnmount(() => {
  if (copiedTimer !== undefined) clearTimeout(copiedTimer);
});
</script>

<template>
  <div v-if="compact" class="rc-share rc-share--compact">
    <div class="rc-share__bar">
      <span class="rc-share__label">{{ t('remoteControl.openOnPhone') }}</span>
      <div class="rc-share__tools">
        <IconButton
          class="rc-share__tool"
          size="sm"
          :label="qrOpen ? t('remoteControl.hideQr') : t('remoteControl.showQr')"
          :tooltip="qrOpen ? t('remoteControl.hideQr') : t('remoteControl.showQr')"
          :pressed="qrOpen"
          @click="qrOpen = !qrOpen"
        >
          <Icon name="device-mobile" />
        </IconButton>
        <IconButton
          class="rc-share__tool"
          size="sm"
          :label="copied ? t('remoteControl.copied') : t('remoteControl.copyLink')"
          :tooltip="copied ? t('remoteControl.copied') : t('remoteControl.copyLink')"
          @click="copyLink"
        >
          <Icon :name="copied ? 'check' : 'copy'" />
        </IconButton>
      </div>
    </div>
    <div v-if="qrOpen && qrDataUrl" class="rc-share__panel">
      <img class="rc-share__panel-qr" :src="qrDataUrl" :alt="t('remoteControl.qrAlt')" />
      <div class="rc-share__panel-copy">
        <span>{{ t('remoteControl.qrCaption') }}</span>
        <span class="rc-share__note">{{ t('remoteControl.securityNote') }}</span>
      </div>
    </div>
    <span v-if="copyFailed" class="rc-share__error">{{ t('remoteControl.copyFailed') }}</span>
  </div>
  <div v-else class="rc-share">
    <div v-if="qrDataUrl" class="rc-share__qr">
      <img class="rc-share__qr-image" :src="qrDataUrl" :alt="t('remoteControl.qrAlt')" />
      <span class="rc-share__qr-caption">{{ t('remoteControl.qrCaption') }}</span>
    </div>
    <div class="rc-share__actions">
      <button type="button" class="rc-share__link" @click="copyLink">
        <Icon :name="copied ? 'check' : 'copy'" size="sm" />
        <span>{{ copied ? t('remoteControl.copied') : t('remoteControl.copyLink') }}</span>
      </button>
      <button type="button" class="rc-share__link" @click="openRemotePage">
        <Icon name="external-link" size="sm" />
        <span>{{ t('remoteControl.openLink') }}</span>
      </button>
    </div>
    <span v-if="copyFailed" class="rc-share__error">{{ t('remoteControl.copyFailed') }}</span>
  </div>
</template>

<style scoped>
.rc-share {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}
.rc-share__qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: #ffffff;
  color: rgba(0, 0, 0, 0.62);
}
.rc-share__qr-image {
  width: 136px;
  height: 136px;
  image-rendering: pixelated;
}
.rc-share__qr-caption {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
}
.rc-share__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-5);
  margin-top: var(--space-3);
}
.rc-share__link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.rc-share__link:hover {
  color: var(--color-text);
}
.rc-share__error {
  margin-top: var(--space-2);
  color: var(--color-danger);
  font-size: var(--text-xs);
}
.rc-share--compact {
  align-items: stretch;
}
.rc-share__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 44px;
  padding: 0 var(--space-3) 0 var(--space-4);
}
.rc-share__label {
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.rc-share__tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}
.rc-share__tool {
  color: var(--color-text-muted);
}
.rc-share__panel {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 0 var(--space-4) var(--space-4);
}
.rc-share__panel-qr {
  flex: none;
  width: 96px;
  height: 96px;
  padding: var(--space-2);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: #ffffff;
  image-rendering: pixelated;
}
.rc-share__panel-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.rc-share__note {
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
}
.rc-share--compact .rc-share__error {
  margin: 0 var(--space-4) var(--space-3);
}
</style>
