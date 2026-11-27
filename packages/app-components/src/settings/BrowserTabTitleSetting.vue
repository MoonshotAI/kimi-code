<script setup lang="ts">
import './settings-row-label.css';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  formatBrowserTabTitleMode,
  formatDocumentTitle,
  useBrowserTabTitle,
  useWrapReorderDrag,
  type BrowserTabTitleToken,
} from '@moonshot-ai/app-client/composables';
import { track } from '@moonshot-ai/app-client/contracts';
import {
  configStore,
  sessionListStore,
  sessionsStore,
  workspacesStore,
} from '@moonshot-ai/app-client/stores';
import { Icon } from '@moonshot-ai/app-ui';

const props = withDefaults(
  defineProps<{
    sourcePanel?: 'settings' | 'mobile_settings';
  }>(),
  { sourcePanel: 'settings' },
);

const { t } = useI18n();
const { segments, toggleSegment, moveSegment } = useBrowserTabTitle();

const tokenBarRef = ref<HTMLElement | null>(null);

const visibleWs = computed(() => workspacesStore().visibleWorkspace);
const sampleWorkspaceRoot = computed(() => visibleWs.value?.root || '/work/kimi-code-app');
const sampleWorkspaceName = computed(() => visibleWs.value?.name || null);
const sampleSessionTitle = computed(() => {
  const sid = sessionsStore().activeSessionId;
  const active =
    sessionsStore().sessions.find((s) => s.id === sid)?.title?.trim() ||
    sessionListStore().doneSessions.find((s) => s.id === sid)?.title?.trim();
  return active || t('settings.fontPreviewUiSessionOne');
});
const webTitle = computed(() => configStore().webTitle || '');

const previewTitle = computed(() =>
  formatDocumentTitle(
    webTitle.value,
    sampleWorkspaceRoot.value,
    sampleSessionTitle.value,
    segments.value,
    sampleWorkspaceName.value,
  ),
);

function reportChanged(): void {
  track('settings_changed', {
    key: 'browser-tab-title',
    value: formatBrowserTabTitleMode(segments.value),
    source_panel: props.sourcePanel,
  });
}

function applyMove(id: BrowserTabTitleToken, to: number): void {
  const before = segments.value.map((s) => `${s.id}:${s.enabled ? 1 : 0}`).join(',');
  moveSegment(id, to);
  const after = segments.value.map((s) => `${s.id}:${s.enabled ? 1 : 0}`).join(',');
  if (after !== before) reportChanged();
}

function applyToggle(id: BrowserTabTitleToken): void {
  toggleSegment(id);
  reportChanged();
}

const chipDrag = useWrapReorderDrag({
  ids: () => segments.value.map((s) => s.id),
  container: tokenBarRef,
  move: (id, to) => applyMove(id as BrowserTabTitleToken, to),
});

function onChipPointerDown(event: PointerEvent, id: BrowserTabTitleToken): void {
  chipDrag.onPointerDown(event, id);
}

function onChipClick(id: BrowserTabTitleToken): void {
  if (chipDrag.consumeClick()) return;
  applyToggle(id);
}

function onChipKeydown(event: KeyboardEvent, id: BrowserTabTitleToken, index: number): void {
  if (event.key === 'ArrowLeft' && index > 0) {
    event.preventDefault();
    applyMove(id, index - 1);
  } else if (event.key === 'ArrowRight' && index < segments.value.length - 1) {
    event.preventDefault();
    applyMove(id, index + 1);
  } else if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    applyToggle(id);
  }
}

function tokenLabel(id: BrowserTabTitleToken): string {
  return id === 'workspace'
    ? t('settings.browserTabTokenProject')
    : t('settings.browserTabTokenSession');
}
</script>

<template>
  <div class="bt-setting">
    <div class="bt-row">
      <span class="settings-row-label bt-rlabel">
        {{ t('settings.browserTabTitle') }}
        <span class="bt-hint">{{ t('settings.browserTabTitleHint') }}</span>
      </span>

      <div
        ref="tokenBarRef"
        class="bt-tokens"
        :class="{ 'is-reordering': chipDrag.draggingId.value !== null }"
      >
        <template v-for="(seg, idx) in segments" :key="seg.id">
          <span v-if="idx > 0" class="bt-sep" aria-hidden="true">·</span>
          <button
            type="button"
            class="bt-chip"
            :class="{
              on: seg.enabled,
              'is-dragging': chipDrag.draggingId.value === seg.id,
            }"
            :style="chipDrag.styleFor(seg.id)"
            :data-reorder-id="seg.id"
            role="switch"
            :aria-checked="seg.enabled"
            :aria-label="tokenLabel(seg.id)"
            @pointerdown="onChipPointerDown($event, seg.id)"
            @click="onChipClick(seg.id)"
            @keydown="onChipKeydown($event, seg.id, idx)"
          >
            <span class="bt-grip" aria-hidden="true"><Icon name="grip" size="sm" /></span>
            <span class="bt-chip-name">{{ tokenLabel(seg.id) }}</span>
            <span class="bt-chip-check" aria-hidden="true">
              <Icon v-if="seg.enabled" name="check" size="sm" />
            </span>
          </button>
        </template>
      </div>
    </div>

    <div class="bt-preview">
      <div class="bt-preview-chrome" aria-hidden="true">
        <div class="bt-preview-tab" :title="previewTitle">
          <span class="bt-fav">
            <span class="bt-fav-eyes">
              <span class="bt-fav-eye bt-fav-eye--l" />
              <span class="bt-fav-eye bt-fav-eye--r" />
            </span>
          </span>
          <span class="bt-preview-title">{{ previewTitle }}</span>
          <span class="bt-preview-close"><Icon name="close" size="sm" /></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bt-setting {
  display: flex;
  flex-direction: column;
  border-top: var(--p-hairline) solid var(--color-line);
}
.bt-setting:first-child {
  border-top: none;
}

.bt-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 0 var(--space-4) var(--space-3);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  user-select: none;
}

.bt-preview-chrome {
  display: flex;
  align-items: flex-end;
  min-width: 0;
  padding: 6px 8px 0;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-text) 5%, var(--color-surface-sunken));
  overflow: hidden;
}

.bt-preview-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 240px;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: var(--p-hairline) solid var(--color-line);
  border-bottom: none;
  border-radius: 7px 7px 0 0;
  background: var(--color-surface-raised);
  box-shadow: 0 -1px 2px rgba(0, 0, 0, 0.03);
  font-size: 12px;
}

.bt-preview-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

.bt-preview-close {
  display: inline-flex;
  flex: none;
  color: var(--color-text-faint);
  opacity: 0.7;
}

.bt-preview-close :deep(.kw-icon) {
  width: 11px;
  height: 11px;
}

.bt-fav {
  position: relative;
  flex: none;
  width: 16px;
  height: 11px;
  border-radius: 3px;
  background: #1783ff;
  overflow: hidden;
}
.bt-fav-eyes {
  position: absolute;
  inset: 0;
  animation: bt-glance 4.3s ease-in-out infinite;
}
.bt-fav-eye {
  position: absolute;
  top: 50%;
  width: 2px;
  height: 4.5px;
  border-radius: 1px;
  background: #ffffff;
  transform: translate(-50%, -50%);
  animation: bt-blink 4.3s ease-in-out infinite;
}
.bt-fav-eye--l {
  left: 6.4px;
}
.bt-fav-eye--r {
  left: 9.6px;
}

@keyframes bt-glance {
  0%, 65% { transform: translateX(0); }
  68%, 76% { transform: translateX(-1.6px); }
  79%, 88% { transform: translateX(1.6px); }
  91%, 100% { transform: translateX(0); }
}
@keyframes bt-blink {
  0%, 95%, 100% { transform: translate(-50%, -50%) scaleY(1); }
  97.5% { transform: translate(-50%, -50%) scaleY(0.15); }
}

.bt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3) var(--space-4);
  flex-wrap: wrap;
  min-height: 52px;
  padding: var(--space-3) var(--space-4);
}

.bt-rlabel { color: var(--color-text); }

.bt-hint {
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
  color: var(--color-text-faint);
}

.bt-tokens {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.bt-sep {
  color: var(--color-text-faint);
  font-weight: 600;
  user-select: none;
}

.bt-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px 0 7px;
  border-radius: var(--radius-md);
  border: var(--p-hairline) dashed var(--color-line-strong);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: background var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.bt-chip:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.bt-chip.on {
  border-style: solid;
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-line));
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: var(--shadow-xs);
}

.bt-chip.is-dragging {
  z-index: 2;
  cursor: grabbing;
  box-shadow: var(--shadow-sm);
}

.bt-grip {
  display: inline-flex;
  color: var(--color-text-faint);
  opacity: 0.7;
}
.bt-grip :deep(.kw-icon) {
  width: 12px;
  height: 12px;
}

.bt-chip-check {
  display: inline-flex;
  width: 13px;
  height: 13px;
  align-items: center;
  justify-content: center;
  color: var(--color-accent);
}
.bt-chip-check :deep(.kw-icon) {
  width: 13px;
  height: 13px;
}

@media (prefers-reduced-motion: reduce) {
  .bt-fav-eyes,
  .bt-fav-eye {
    animation: none;
  }
}
</style>
