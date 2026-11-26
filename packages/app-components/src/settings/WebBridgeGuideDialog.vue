<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Icon } from '@moonshot-ai/app-ui';
import { WEBBRIDGE_EXTENSION_LINKS, type WebBridgeBrowser } from './webBridgeExtension';

withDefaults(defineProps<{
  open: boolean;
  checking?: boolean;
}>(), {
  checking: false,
});

const emit = defineEmits<{
  later: [];
  done: [];
  selectBrowser: [browser: WebBridgeBrowser];
}>();

const { t } = useI18n();
const browsers = Object.keys(WEBBRIDGE_EXTENSION_LINKS) as WebBridgeBrowser[];
</script>

<template>
  <Dialog
    :open="open"
    size="md"
    :title="t('settings.plugins.webbridgeGuideTitle')"
    :description="t('settings.plugins.webbridgeGuideDescription')"
    :hide-close="true"
    :close-on-esc="!checking"
    :close-on-overlay="!checking"
    @update:open="!$event && emit('later')"
  >
    <div class="wb-guide__browsers">
      <button
        v-for="browser in browsers"
        :key="browser"
        type="button"
        class="wb-guide__browser"
        :data-browser="browser"
        @click="emit('selectBrowser', browser)"
      >
        <span class="wb-guide__browser-icon" aria-hidden="true">
          <svg v-if="browser === 'chrome'" viewBox="0 0 24 24" width="18" height="18">
            <circle cx="12" cy="12" r="4.5" fill="#4285F4" />
            <path d="M12 3a9 9 0 0 1 7.79 4.5H12a4.5 4.5 0 0 0-4.14 2.73L5.06 5.2A8.96 8.96 0 0 1 12 3Z" fill="#EA4335" />
            <path d="M19.79 7.5A9 9 0 0 1 12 21l3.38-5.86A4.5 4.5 0 0 0 16.5 12c0-.62-.13-1.21-.35-1.75l3.64-2.75Z" fill="#FBBC05" />
            <path d="M12 21a9 9 0 0 1-6.94-14.6l3.6 6.23A4.5 4.5 0 0 0 12 16.5c.62 0 1.21-.13 1.75-.35L12 21Z" fill="#34A853" />
            <circle cx="12" cy="12" r="3.6" fill="#fff" />
            <circle cx="12" cy="12" r="2.9" fill="#4285F4" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18">
            <defs>
              <linearGradient id="wb-edge-a" x1="4" y1="3" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#35D399" />
                <stop offset="1" stop-color="#0EA5E9" />
              </linearGradient>
              <linearGradient id="wb-edge-b" x1="5" y1="12" x2="18" y2="21" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#2563EB" />
                <stop offset="1" stop-color="#38BDF8" />
              </linearGradient>
            </defs>
            <path d="M20.5 12.2c0-5.1-3.8-9-8.9-9C7.1 3.2 3.3 7.1 3 12.4c1.6-2.8 4.3-4.4 8.1-4.4 3.2 0 5.4 1.3 5.4 3.4 0 1.7-1.2 2.6-3.3 2.6h-1.4c.3 2.8 2.5 4.7 5.4 4.7 1.2 0 2.3-.3 3.3-.8-1.1 1.7-3.4 2.9-6.1 2.9-4.4 0-7.3-2.7-7.3-6.3 0-1.1.3-2.1.8-3-1.9 1.4-3 3.7-3 6.3 0 4.6 3.6 8 8.6 8 4.5 0 7.8-2.8 8.3-6.8-2.1 1-4.3 1.2-6.1.4 2.6-.6 4.3-3.1 4.3-7.2Z" fill="url(#wb-edge-b)" />
            <path d="M11.6 3.2c5.1 0 8.9 3.9 8.9 9 0 4.1-1.7 6.6-4.3 7.2 1.8.8 4 .6 6.1-.4-.2-1.5-1-2.7-2.2-3.5 1.3-2.6.8-6-1.6-8.5-2-2.2-4.9-3.3-8.1-2.7.4-.4.8-.9 1.2-1.1Z" fill="url(#wb-edge-a)" />
          </svg>
        </span>
        <span class="wb-guide__browser-label">{{ WEBBRIDGE_EXTENSION_LINKS[browser].label }}</span>
        <Icon name="external-link" size="sm" class="wb-guide__external" />
      </button>
    </div>
    <template #foot>
      <Button variant="secondary" :disabled="checking" @click="emit('later')">
        {{ t('settings.plugins.webbridgeGuideLater') }}
      </Button>
      <Button variant="primary" :loading="checking" @click="emit('done')">
        {{ t('settings.plugins.webbridgeGuideDone') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.wb-guide__browsers {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.wb-guide__browser {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.wb-guide__browser:hover {
  background: var(--color-hover);
}

.wb-guide__browser:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.wb-guide__browser-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
}

.wb-guide__browser-label {
  flex: 1;
  min-width: 0;
}

.wb-guide__external {
  flex: none;
  color: var(--color-text-faint);
}
</style>
