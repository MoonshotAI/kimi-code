<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import type { IconName } from '@moonshot-ai/app-ui/icons';
import { useCanaryChannel, useUpdateStatus } from '@moonshot-ai/app-client/composables';
import { track } from '../lib/track';

const { t } = useI18n();
const update = useUpdateStatus();
const canary = useCanaryChannel();

const status = update.status;
const visible = update.visible;
const open = update.dialogOpen;

const currentVersion =
  typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim()
    ? __KIMI_CLIENT_VERSION__
    : '';

const trackChannel = currentVersion.includes('-canary.') ? 'canary' : 'stable';

const pillText = computed(() => {
  switch (status.value.state) {
    case 'available':
      return t('sidebar.update');
    case 'downloading':
      return `${status.value.percent ?? 0}%`;
    case 'downloaded':
      return t('sidebar.updateDone');
    case 'error':
      return t('sidebar.updateFailed');
    default:
      return '';
  }
});

const shortPillText = computed(() =>
  status.value.state === 'downloaded' ? t('sidebar.updateRestartShort') : pillText.value,
);

const icon = computed<IconName>(() => {
  switch (status.value.state) {
    case 'error':
      return 'alert-triangle';
    default:
      return 'download';
  }
});

function versionProps(): { version?: string } {
  const version = status.value.version;
  return version === undefined ? {} : { version };
}

function trackShown(properties: { version?: string }): void {
  track('update_prompt_shown', { ...properties, channel: trackChannel });
}

const shownForVersions = new Set<string>();
watch(visible, (isVisible) => {
  if (!isVisible) return;
  const key = status.value.version ?? status.value.state;
  if (shownForVersions.has(key)) return;
  shownForVersions.add(key);
  trackShown(versionProps());
});
</script>

<template>
  <span v-if="visible" class="upd" :class="{ 'upd--canary': canary.enabled.value }" :data-state="status.state">
    <Tooltip :text="pillText" placement="bottom">
      <button class="upd-pill" type="button" :aria-label="pillText" @click="open = true">
        <Icon class="upd-pill-icon" :name="icon" size="sm" />
        <span class="upd-pill-text upd-pill-text-full">{{ pillText }}</span>
        <span class="upd-pill-text upd-pill-text-short">{{ shortPillText }}</span>
      </button>
    </Tooltip>
  </span>
</template>

<style scoped>
.upd {
  display: inline-flex;
  flex: none;
  -webkit-app-region: no-drag;
  animation: upd-in var(--duration-base) var(--ease-out);
}
@keyframes upd-in {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
}

.upd-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-warning);
  color: var(--color-text-on-accent);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  white-space: nowrap;
  cursor: pointer;
  transition: filter var(--duration-fast) var(--ease-out);
}
.upd-pill:hover {
  filter: brightness(1.1);
}
.upd-pill:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.upd-pill-icon {
  flex: none;
  color: var(--color-text-on-accent);
}
:where(.upd[data-state='downloading']) .upd-pill-text-full {
  display: inline-block;
  min-width: 4ch;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.upd-pill-text-short {
  display: none;
}

@container sidebar-header (max-width: 250px) {
  .upd--canary .upd-pill-text-full {
    display: none;
  }
  .upd--canary .upd-pill-text-short {
    display: inline;
  }
}

@container sidebar-header (max-width: 230px) {
  .upd--canary .upd-pill {
    padding: var(--space-1);
  }
  .upd--canary .upd-pill-text-full,
  .upd--canary .upd-pill-text-short {
    display: none;
  }
  .upd--canary[data-state='downloading'] .upd-pill-text-short {
    display: inline;
  }
}

@container sidebar-header (max-width: 210px) {
  .upd:not(.upd--canary) .upd-pill-text-full {
    display: none;
  }
  .upd:not(.upd--canary) .upd-pill-text-short {
    display: inline;
  }
}

@container sidebar-header (max-width: 190px) {
  .upd:not(.upd--canary) .upd-pill {
    padding: var(--space-1);
  }
  .upd:not(.upd--canary) .upd-pill-text-full,
  .upd:not(.upd--canary) .upd-pill-text-short {
    display: none;
  }
}

</style>
