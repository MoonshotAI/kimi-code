<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Button, Dialog } from '@moonshot-ai/app-ui';
import type { ScreenshotGuidance, ScreenshotGuidanceAction, ScreenshotGuidanceBridge } from '../../../shared/screenshot-guidance';
import { screenshotGuidanceCopy } from './screenshot-guidance-copy';

const guide = ref<ScreenshotGuidance | null>(null);
const restartConfirmation = ref(false);
const helpOpen = ref(false);
const hidden = ref(false);
const actionFailed = ref(false);
const busy = ref(false);
const s = computed(() => screenshotGuidanceCopy[guide.value?.locale ?? 'en']);
const mac = computed(() => guide.value?.platform === 'darwin');
const restricted = computed(() => guide.value?.kind === 'restricted');
const checking = computed(() => guide.value?.phase === 'checking');
const ready = computed(() => guide.value?.phase === 'ready');
const title = computed(() => restartConfirmation.value ? s.value.restartTitle
  : ready.value ? s.value.readyTitle : helpOpen.value ? s.value.helpTitle
  : guide.value?.kind === 'capture' ? s.value.captureTitle : s.value.permissionTitle);
const primaryAction = computed<ScreenshotGuidanceAction>(() => {
  if (ready.value) return 'continue';
  if (!mac.value || guide.value?.kind === 'capture' || guide.value?.settingsOpened || checking.value) return 'check';
  return guide.value?.canRequest ? 'request' : 'settings';
});
const primaryLabel = computed(() => {
  if (checking.value) return s.value.checking;
  if (primaryAction.value === 'continue') return s.value.continue;
  if (primaryAction.value === 'request') return s.value.request;
  if (primaryAction.value === 'settings') return s.value.settings;
  return mac.value && guide.value?.kind === 'permission' ? s.value.check : s.value.retry;
});
const status = computed(() => {
  if (actionFailed.value) return s.value.actionFailed;
  if (guide.value?.notice === 'settings-failed') return s.value.settingsFailed;
  if (guide.value?.notice === 'not-ready') return guide.value.kind === 'permission' ? s.value.blocked : s.value.unavailable;
  return '';
});
let unsubscribe: (() => void) | undefined;
let disposed = false;

function desktopBridge(): ScreenshotGuidanceBridge | undefined {
  return (window as { kimiDesktop?: ScreenshotGuidanceBridge }).kimiDesktop;
}

async function act(action: ScreenshotGuidanceAction): Promise<void> {
  const current = guide.value;
  const bridge = desktopBridge();
  if (!current || !bridge || (busy.value && action !== 'cancel')) return;
  busy.value = true;
  actionFailed.value = false;
  try {
    if (action === 'continue') {
      hidden.value = true;
      await nextTick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (disposed || guide.value?.captureId !== current.captureId) return;
    }
    await bridge.screenshotGuidanceAction(current.captureId, action);
  } catch {
    if (guide.value?.captureId === current.captureId) {
      actionFailed.value = true;
      hidden.value = false;
    }
  } finally {
    busy.value = false;
  }
}

function receive(value: ScreenshotGuidance | null): void {
  if (disposed) return;
  if (guide.value?.captureId !== value?.captureId) {
    hidden.value = false;
    restartConfirmation.value = false;
    helpOpen.value = false;
    actionFailed.value = false;
  }
  guide.value = value;
}

function onKeydown(event: KeyboardEvent): void {
  if (!guide.value || hidden.value || event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void act('cancel');
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  const bridge = desktopBridge();
  if (!bridge?.onScreenshotGuidance) return;
  let eventReceived = false;
  unsubscribe = bridge.onScreenshotGuidance((value) => { eventReceived = true; receive(value); });
  void bridge.getScreenshotGuidance().then((value) => { if (!eventReceived) receive(value); }).catch(() => {});
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  disposed = true;
  unsubscribe?.();
  if (guide.value) void desktopBridge()?.screenshotGuidanceAction(guide.value.captureId, 'cancel').catch(() => {});
});
</script>

<template>
  <Dialog :open="guide !== null && !hidden" :title="title" size="sm" :close-on-overlay="false" :close-on-esc="false" @close="act('cancel')">
    <div v-if="guide" class="screenshot-guide">
      <template v-if="restartConfirmation">
        <p>{{ s.restartDescription }}</p>
      </template>
      <template v-else>
        <p v-if="restricted">{{ s.restricted }}</p>
        <p v-else-if="ready" role="status">{{ s.ready }}</p>
        <template v-else-if="helpOpen">
          <template v-if="mac">
            <p>{{ s.settingsPath }}<small>{{ s.olderSettings }}</small></p>
            <Button v-if="primaryAction !== 'settings'" variant="text" :disabled="busy || checking" @click="act('settings')">{{ s.settings }}</Button>
            <div v-if="guide.canRevealApp" class="screenshot-guide__help-section">
              <p>{{ s.addApp }}</p>
              <Button variant="text" :disabled="busy" @click="act('reveal')">{{ s.reveal }}</Button>
            </div>
            <div v-if="!guide.canRequest" class="screenshot-guide__help-section">
              <p>{{ s.macRecovery }}</p>
              <Button variant="text" :disabled="busy || checking" @click="restartConfirmation = true">{{ s.restart }}</Button>
            </div>
          </template>
          <p v-else>{{ guide.platform === 'win32' ? s.windowsHelp : s.linuxRecovery }}</p>
        </template>
        <template v-else-if="mac && guide.kind === 'permission'">
          <p>{{ guide.canRequest ? s.requestBefore : s.permissionBefore }} <strong>{{ guide.appName }}</strong> {{ s.permissionAfter }}</p>
        </template>
        <template v-else-if="mac">
          <p>{{ s.captureDescription }}</p>
        </template>
        <template v-else>
          <p>{{ guide.platform === 'win32' ? s.windowsRecovery : s.linuxRecovery }}</p>
          <p v-if="guide.platform === 'win32'" class="screenshot-guide__hint">{{ s.windowsFallback }}</p>
        </template>
        <p v-if="status && !ready" role="status" aria-live="polite">{{ status }}</p>
      </template>
    </div>
    <template #foot>
      <div v-if="guide" class="screenshot-guide__actions">
        <template v-if="restartConfirmation">
          <Button variant="ghost" @click="restartConfirmation = false">{{ s.back }}</Button>
          <Button :disabled="busy" @click="act('restart')">{{ s.restartConfirm }}</Button>
        </template>
        <template v-else>
          <Button v-if="restricted" variant="secondary" @click="act('cancel')">{{ s.close }}</Button>
          <template v-else>
            <Button v-if="!ready" variant="ghost" :aria-expanded="helpOpen" @click="helpOpen = !helpOpen">{{ helpOpen ? s.back : s.help }}</Button>
            <span class="screenshot-guide__spacer" />
            <Button :loading="checking" :disabled="busy" @click="act(primaryAction)">{{ primaryLabel }}</Button>
          </template>
        </template>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.screenshot-guide { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); font-size: var(--text-base); line-height: var(--leading-relaxed); overflow-wrap: anywhere; }
.screenshot-guide p { margin: 0; }
.screenshot-guide small, .screenshot-guide__hint { display: block; color: var(--color-text-muted); font-size: var(--text-sm); }
.screenshot-guide strong { font-weight: var(--weight-medium); }
.screenshot-guide__help-section { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); margin-top: var(--space-2); }
.screenshot-guide__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); width: 100%; }
.screenshot-guide__spacer { flex: 1; }
</style>
