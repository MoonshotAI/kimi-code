<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  hasCustomTitleBar,
  isLinuxDesktop,
  isMacosDesktop,
  isWindowsDesktop,
} from '@moonshot-ai/app-core/lib';
import { Badge, Icon, IconButton } from '@moonshot-ai/app-ui';
import KimiCodeWordmark from '../KimiCodeWordmark.vue';
import KimiMascotPeek from '../KimiMascotPeek.vue';
import { FontPreviewBrandKey, fontPreviewChrome, type FontPreviewChrome } from './fontPreviewChrome';

const props = defineProps<{ chrome?: FontPreviewChrome }>();

const { t } = useI18n();
const brand = inject(FontPreviewBrandKey, null);

const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 440;
const MAX_HEIGHT = 380;

const chrome = computed<FontPreviewChrome>(
  () => props.chrome ?? fontPreviewChrome({ isMacosDesktop, isWindowsDesktop, isLinuxDesktop, hasCustomTitleBar }),
);
const titleBar = computed(() => chrome.value === 'windows' || chrome.value === 'linux');
const menus = ['app.menuFile', 'app.menuEdit', 'app.menuView', 'app.menuHelp'] as const;

const frameRef = ref<HTMLElement>();
const frameWidth = ref(0);
const scale = computed(() => {
  const width = frameWidth.value > 0 ? frameWidth.value : WINDOW_WIDTH * 0.6;
  return Math.min(width / WINDOW_WIDTH, MAX_HEIGHT / WINDOW_HEIGHT);
});
let observer: ResizeObserver | undefined;

onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !frameRef.value) return;
  observer = new ResizeObserver((entries) => {
    frameWidth.value = entries[0]?.contentRect.width ?? 0;
  });
  observer.observe(frameRef.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div
    ref="frameRef"
    class="fup"
    role="img"
    :aria-label="t('settings.fontPreview')"
    :style="{ height: `${Math.round(WINDOW_HEIGHT * scale)}px` }"
  >
    <div
      class="fup-window"
      :class="`fup-window--${chrome}`"
      :data-chrome="chrome"
      :style="{ width: `${WINDOW_WIDTH}px`, height: `${WINDOW_HEIGHT}px`, transform: `scale(${scale})` }"
      aria-hidden="true"
      inert
    >
      <header v-if="titleBar" class="fup-titlebar">
        <span class="fup-titlebar-brand">
          <component :is="brand" v-if="brand" :size="24" variant="theme" />
          <span>Kimi Code</span>
        </span>
        <IconButton class="fup-titlebar-toggle" size="sm"><Icon name="panel-collapse" /></IconButton>
        <span class="fup-menubar">
          <span v-for="key in menus" :key="key" class="fup-menu">{{ t(key) }}</span>
        </span>
        <span class="fup-grow" />
        <span v-if="chrome === 'windows'" class="fup-caption-win">
          <span class="fup-caption-btn" data-caption="minimize">
            <svg viewBox="0 0 10 10"><path d="M0 5.5h10" /></svg>
          </span>
          <span class="fup-caption-btn" data-caption="maximize">
            <svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
          </span>
          <span class="fup-caption-btn" data-caption="close">
            <svg viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
          </span>
        </span>
        <span v-else class="fup-caption-gnome">
          <span class="fup-gnome-close" data-caption="close">
            <svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" /></svg>
          </span>
        </span>
      </header>
      <div class="fup-body">
        <aside class="fup-side">
          <div v-if="chrome === 'macos'" class="fup-ch fup-ch--macos">
            <span class="fup-lights" data-caption="traffic-lights">
              <i class="fup-light fup-light--close" />
              <i class="fup-light fup-light--min" />
              <i class="fup-light fup-light--max" />
            </span>
            <IconButton class="fup-mac-toggle" size="sm"><Icon name="panel-collapse" /></IconButton>
          </div>
          <div v-else-if="chrome === 'plain'" class="fup-ch">
            <span class="fup-ch-brand">
              <component :is="brand" v-if="brand" :size="22" variant="theme" />
              <span class="fup-ch-name">Kimi Code</span>
            </span>
            <IconButton size="sm"><Icon name="panel-collapse" /></IconButton>
          </div>
          <div class="fup-actions">
            <span class="fup-action"><Icon name="chat-new" /><span>{{ t('sidebar.newChat') }}</span></span>
            <span class="fup-action"><Icon name="search" /><span>{{ t('sidebar.search') }}</span></span>
          </div>
          <div class="fup-sessions-head">
            <div class="fup-section-label">
              <span class="fup-section-title">{{ t('sidebar.workspaces') }}</span>
              <span class="fup-section-actions">
                <IconButton class="fup-section-toggle" size="sm"><Icon name="collapse" /></IconButton>
                <IconButton class="fup-section-toggle" size="sm"><Icon name="folder-plus" /></IconButton>
                <IconButton class="fup-section-toggle" size="sm"><Icon name="view-switch" /></IconButton>
              </span>
            </div>
          </div>
          <div class="fup-sessions">
            <div class="fup-gh"><Icon class="fup-gh-folder" name="folder" /><span class="fup-gh-name">kimi-code</span></div>
            <div class="fup-se">
              <span class="fup-lead" />
              <span class="fup-t">{{ t('settings.fontPreviewUiSessionOne') }}</span>
              <span class="fup-ts">2m</span>
            </div>
            <div class="fup-se">
              <span class="fup-lead" />
              <span class="fup-t">{{ t('settings.fontPreviewUiSessionTwo') }}</span>
              <span class="fup-ts">1d</span>
            </div>
            <div class="fup-gh"><Icon class="fup-gh-folder" name="folder" /><span class="fup-gh-name">moon-landing</span></div>
            <div class="fup-se">
              <span class="fup-lead" />
              <span class="fup-t">{{ t('settings.fontPreviewUiSessionLanding') }}</span>
              <span class="fup-st"><span class="fup-unread" /></span>
            </div>
          </div>
          <div class="fup-footer">
            <span class="fup-account">
              <span class="fup-avatar"><Icon name="user" size="sm" /></span>
              <span class="fup-account-name">Neil</span>
              <Badge variant="neutral" size="sm">Allegretto</Badge>
            </span>
            <IconButton size="sm"><Icon name="settings" /></IconButton>
          </div>
        </aside>
        <main class="fup-main">
          <div class="fup-toggles">
            <IconButton class="fup-toggle"><Icon name="terminal" size="sm" /></IconButton>
            <IconButton class="fup-toggle"><Icon name="panel-expand-right" size="sm" /></IconButton>
          </div>
          <div class="fup-content">
            <div class="fup-spacer" />
            <div class="fup-hint"><KimiCodeWordmark class="fup-wordmark" /></div>
            <div class="fup-pill-row">
              <span class="fup-chip">
                <Icon name="folder-closed" />
                <span class="fup-chip-name">moon-landing</span>
                <Icon class="fup-chip-chev" name="chevron-down" size="sm" />
              </span>
              <KimiMascotPeek class="fup-mascot" />
            </div>
            <div class="fup-composer">
              <div class="fup-cin">
                <span class="fup-ph">{{ t('composer.placeholder') }}</span>
                <span class="fup-expand"><Icon name="expand" size="sm" /></span>
              </div>
              <div class="fup-toolbar">
                <span class="fup-toolbar-left">
                  <IconButton class="fup-attach" size="md"><Icon name="attachment" /></IconButton>
                  <IconButton class="fup-attach" size="md"><Icon name="plus" /></IconButton>
                  <span class="fup-perm"><Icon name="hand" size="md" /><span>{{ t('status.permissionManual') }}</span></span>
                </span>
                <span class="fup-toolbar-right">
                  <span class="fup-model">
                    <span class="fup-model-name">Kimi K3.1 Pro</span>
                    <span class="fup-think">{{ t('composer.thinkingSuffix') }}</span>
                    <Icon class="fup-model-chev" name="chevron-down" size="sm" />
                  </span>
                  <span class="fup-send"><Icon name="send" size="sm" /></span>
                </span>
              </div>
            </div>
            <div class="fup-composer-gap" />
          </div>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fup {
  position: relative;
  min-width: 0;
  overflow: hidden;
}
.fup-window {
  --sb-inset: var(--space-2);
  --sb-pad-x: var(--space-4);
  --sb-gutter: 16px;
  --sb-gap: var(--space-2);
  --sb-action-inset: calc((max(var(--ui-font-size-sm) * var(--leading-tight), var(--p-ic-md)) + 2 * var(--space-2) - var(--icon-button-sm)) / 2);
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-window);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  line-height: var(--leading-normal);
  transform-origin: top left;
  user-select: none;
  pointer-events: none;
}
.fup-window--windows,
.fup-window--linux {
  border-radius: var(--radius-md);
}
.fup-window :deep(.ui-icon-button) {
  color: var(--color-text-muted);
}
.fup-grow { flex: 1; }

.fup-titlebar {
  display: flex;
  flex: none;
  align-items: center;
  height: 40px;
  padding-left: var(--space-3);
  box-sizing: border-box;
  background: var(--color-sidebar-bg);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.fup-titlebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.fup-titlebar-toggle { margin-left: var(--space-2); }
.fup-menubar {
  display: flex;
  align-items: center;
  height: 100%;
  margin-left: var(--space-2);
}
.fup-menu {
  display: inline-flex;
  align-items: center;
  height: calc(40px - 2 * var(--space-1));
  padding: 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.fup-caption-win {
  display: flex;
  align-self: stretch;
}
.fup-caption-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  color: var(--color-text);
}
.fup-caption-btn svg,
.fup-gnome-close svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.fup-caption-btn[data-caption='close'] svg { shape-rendering: geometricPrecision; }
.fup-caption-gnome {
  display: flex;
  align-items: center;
  padding-right: var(--space-2);
}
.fup-gnome-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-text) 10%, transparent);
  color: var(--color-text);
}
.fup-gnome-close svg {
  stroke-width: 1.5;
  stroke-linecap: round;
  shape-rendering: geometricPrecision;
}

.fup-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.fup-side {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 240px;
  box-sizing: border-box;
  background: var(--color-sidebar-bg);
  border-right: var(--p-hairline) solid var(--line);
}
.fup-window--windows .fup-side,
.fup-window--linux .fup-side {
  padding-top: var(--space-2);
}
.fup-ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: calc(26px + 2 * var(--space-3));
  padding: var(--space-3);
  box-sizing: border-box;
}
.fup-ch--macos {
  justify-content: flex-start;
  padding-left: 20px;
}
.fup-lights {
  display: flex;
  gap: 8px;
}
.fup-light {
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  box-shadow: inset 0 0 0 0.5px rgb(0 0 0 / 0.12);
}
.fup-light--close { background: #ff5f57; }
.fup-light--min { background: #febc2e; }
.fup-light--max { background: #28c840; }
.fup-mac-toggle { margin-left: 12px; }
.fup-ch-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.fup-ch-name {
  color: var(--color-text);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  line-height: 22px;
}
.fup-actions {
  display: flex;
  flex-direction: column;
  padding: 0 var(--sb-inset) var(--space-1);
}
.fup-action {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  color: var(--color-text);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}
.fup-action :deep(svg) { flex: none; }
.fup-sessions-head {
  padding: var(--space-3) var(--sb-inset) 0;
}
.fup-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--sb-action-inset) var(--space-1) var(--space-2);
  color: var(--faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
}
.fup-section-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.fup-window .fup-section-toggle { color: var(--faint); }
.fup-section-toggle :deep(svg) {
  width: 13px;
  height: 13px;
}
.fup-sessions {
  flex: 1;
  min-height: 0;
  padding: 0 var(--sb-inset);
  overflow: hidden;
}
.fup-gh {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
}
.fup-gh-folder {
  flex: none;
  color: var(--color-text-muted);
}
.fup-gh-name {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fup-se {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  padding: 8px var(--space-2);
}
.fup-lead {
  flex: none;
  width: var(--sb-gutter);
}
.fup-t {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fup-ts {
  flex: none;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-tight);
  font-variant-numeric: tabular-nums;
}
.fup-st {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: var(--icon-button-sm);
}
.fup-unread {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
.fup-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) calc(var(--sb-inset) + var(--sb-action-inset)) var(--space-2) var(--sb-inset);
  border-top: var(--p-hairline) solid var(--line);
}
.fup-account {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--sb-gap);
  min-width: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  color: var(--color-text);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}
.fup-avatar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
}
.fup-account-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fup-main {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}
.fup-toggles {
  position: absolute;
  top: 11px;
  right: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.fup-window .fup-toggle {
  width: var(--icon-button-sm);
  height: var(--icon-button-sm);
  border-radius: var(--radius-sm);
}
.fup-toggle :deep(svg) {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
}
.fup-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
  padding: 0 var(--space-6);
  box-sizing: border-box;
}
.fup-spacer { flex: 1; }
.fup-composer-gap { flex: none; height: var(--space-6); }
.fup-hint {
  display: flex;
  justify-content: center;
  padding: 0 16px 16px;
  color: var(--color-text);
}
.fup-wordmark { width: 304px; }
.fup-pill-row {
  display: flex;
  align-items: flex-end;
  height: 36px;
  padding: 0 16px 0 calc(16px + var(--space-4));
}
.fup-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 var(--space-2);
  border-radius: 10px;
  background: var(--color-selected);
  color: var(--color-text);
  font-size: var(--ui-font-size-sm);
}
.fup-chip-name { font-weight: var(--weight-option-label); }
.fup-mascot {
  flex: none;
  width: 65px;
  height: 36px;
  margin-left: auto;
  margin-right: var(--space-8);
}
.fup-composer {
  position: relative;
  border: var(--p-hairline) solid var(--color-composer-line);
  border-radius: var(--radius-composer);
  corner-shape: var(--corner-shape-composer);
  background: var(--color-composer-bg);
  box-shadow: var(--shadow-input);
}
.fup-cin {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 14px 16px 8px;
}
.fup-ph {
  flex: 1;
  min-height: 4.5em;
  color: var(--faint);
  font-size: var(--content-font-size);
  line-height: 1.5;
}
.fup-expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--dim);
}
.fup-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2) var(--space-2);
}
.fup-toolbar-left,
.fup-toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.fup-window .fup-attach {
  width: var(--space-8);
  height: var(--space-8);
  border-radius: var(--radius-full);
  color: var(--color-text);
}
.fup-perm,
.fup-model {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--space-8);
  padding: 0 var(--space-3);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
}
.fup-perm {
  padding-left: var(--space-2);
  color: var(--dim);
  font-size: var(--ui-font-size-sm);
}
.fup-model { font-size: var(--ui-font-size); }
.fup-model-name { color: var(--color-text); }
.fup-think { color: var(--color-accent); }
.fup-model-chev { color: var(--faint); }
.fup-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--space-8);
  height: var(--space-8);
  border-radius: var(--radius-full);
  background: var(--color-send-bg-disabled);
  color: var(--color-send-icon-disabled);
  opacity: var(--opacity-send-disabled);
}
</style>
