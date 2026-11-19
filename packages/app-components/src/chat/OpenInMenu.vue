<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OpenInServiceKey, type OpenInAppEntry } from '@moonshot-ai/app-client/contracts';
import { resolvePreferredOpenInTarget, useDefaultOpenInTarget } from '../lib/openInTarget';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, Menu, MenuItem, Tooltip } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  workDir?: string;
  filePath?: string;
}>();

const openInService = inject(OpenInServiceKey);

const openTargetPath = computed(() => props.filePath ?? props.workDir);
const hasTarget = computed(() => Boolean(openTargetPath.value && openTargetPath.value.trim().length > 0));

const catalog = ref<OpenInAppEntry[]>([]);
onMounted(async () => {
  catalog.value = openInService ? await openInService.catalog(props.filePath ? 'file' : 'dir', props.filePath) : [];
});

const visibleTargets = computed(() => catalog.value);

const hasApps = computed(() => visibleTargets.value.length > 0);

const selectedTargetId = useDefaultOpenInTarget();
const sessionTargetId = ref<string | null>(null);

const quickTargetId = computed(() =>
  resolvePreferredOpenInTarget(visibleTargets.value, sessionTargetId.value, selectedTargetId.value),
);

const quickTargetLabel = computed(
  () => visibleTargets.value.find((t) => t.id === quickTargetId.value)?.label ?? null,
);

const quickTargetIcon = computed(() =>
  quickTargetId.value === null || !openInService ? '' : openInService.icon(quickTargetId.value),
);

const quickTooltipText = computed(() =>
  quickTargetLabel.value === null
    ? t('header.openInEditor')
    : t('header.openInApp', { app: quickTargetLabel.value }),
);

function executeOpen(id: string): void {
  if (!hasTarget.value || !openInService) return;
  void openInService.open(id, { path: openTargetPath.value! });
}

function handleOpenTarget(id: string): void {
  sessionTargetId.value = id;
  closeMenu();
  executeOpen(id);
}

function handleQuickOpen(): void {
  const id = quickTargetId.value;
  if (id !== null) executeOpen(id);
}

const menuOpen = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || triggerRef.value?.contains(target)) return;
  closeMenu();
}

function onResize(): void {
  closeMenu();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeMenu();
}

async function openMenu(): Promise<void> {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', closeMenu);
  await nextTick();
  const btn = triggerRef.value;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('blur', closeMenu);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('blur', closeMenu);
});

const copiedPath = ref(false);
async function copyPath(): Promise<void> {
  const path = openTargetPath.value;
  if (!path) return;
  const ok = await copyTextToClipboard(path);
  if (!ok) return;
  copiedPath.value = true;
  setTimeout(() => { copiedPath.value = false; }, 1200);
}
</script>

<template>
  <div v-if="hasApps || filePath" class="open-in" :class="{ open: menuOpen }">
    <Tooltip :text="hasApps ? quickTooltipText : (copiedPath ? t('header.copied') : t('header.copyPath'))">
      <button
        type="button"
        class="open-in-main"
        :disabled="!hasTarget"
        :aria-label="hasApps ? quickTooltipText : t('header.copyPath')"
        @click.stop="hasApps ? handleQuickOpen() : copyPath()"
      >
        <template v-if="hasApps">
          <img v-if="quickTargetIcon !== ''" class="open-in-icon" :src="quickTargetIcon" alt="" />
          <Icon v-else name="external-link" size="sm" />
        </template>
        <Icon v-else :name="copiedPath ? 'check' : 'link'" size="sm" />
      </button>
    </Tooltip>
    <span v-if="hasApps" class="open-in-sep" aria-hidden="true" />
    <Tooltip v-if="hasApps" :text="t('header.chooseOpenApp')">
      <button
        ref="triggerRef"
        type="button"
        class="open-in-caret"
        :disabled="!hasTarget"
        :aria-expanded="menuOpen"
        aria-haspopup="menu"
        :aria-label="t('header.chooseOpenApp')"
        @click.stop="openMenu"
      >
        <Icon name="chevron-down" size="sm" />
      </button>
    </Tooltip>

    <Menu
      v-if="menuOpen"
      ref="menuRef"
      class="open-in-menu"
      :style="menuStyle"
      @click.stop
    >
      <MenuItem
        v-for="target in visibleTargets"
        :key="target.id"
        :active="target.id === quickTargetId"
        @click="handleOpenTarget(target.id)"
      >
        <img v-if="openInService?.icon(target.id)" class="om-icon" :src="openInService?.icon(target.id)" alt="" />
        <Icon v-else name="external-link" size="sm" />
        <span class="om-label">{{ target.label }}</span>
      </MenuItem>
      <MenuItem separator />
      <MenuItem @click="copyPath">
        <Icon :name="copiedPath ? 'check' : 'copy'" size="sm" />
        {{ copiedPath ? t('header.copied') : t('header.copyPath') }}
      </MenuItem>
    </Menu>
  </div>
</template>

<style scoped>
.open-in {
  display: inline-flex;
  align-items: stretch;
  flex: none;
  height: 26px;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}
.open-in,
.open-in * {
  -webkit-app-region: no-drag;
}
.open-in-main,
.open-in-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0;
}
.open-in-main { width: 30px; }
.open-in-caret { width: 22px; }
.open-in-main:hover:not(:disabled),
.open-in-caret:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-text-strong);
}
.open-in-main:focus-visible,
.open-in-caret:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.open-in-main:disabled,
.open-in-caret:disabled { cursor: default; opacity: 0.5; }
.open-in.open .open-in-caret { background: var(--color-selected); color: var(--color-text-strong); }
.open-in-sep {
  flex: none;
  width: var(--p-hairline);
  margin: 5px 0;
  background: var(--color-line);
}
.open-in-icon { width: 16px; height: 16px; border-radius: 4px; }

.open-in-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
.om-icon { width: 16px; height: 16px; flex: none; border-radius: 4px; }
.om-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
