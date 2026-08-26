<!-- "Open workspace in <app>" control: a compact pill in the chat header. Left
     half = current target's icon, click opens with it; right caret expands the
     app menu. Picking a menu item opens immediately and becomes the shown
     target. The app catalog and the launch come from the injected
     OpenInService (desktop: native bridge; web: daemon) — an empty catalog
     hides the whole control, which is the no-bridge degradation. -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OpenInServiceKey, type OpenInAppEntry } from '@moonshot-ai/app-client/contracts';
import { resolveOpenInTarget, saveDefaultOpenInTarget, useDefaultOpenInTarget } from '../lib/openInTarget';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, Menu, MenuItem, Tooltip } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  /** Absolute path of the workspace to open; the control is disabled without it. */
  workDir?: string;
}>();

const openInService = inject(OpenInServiceKey);

const hasWorkDir = computed(() => Boolean(props.workDir && props.workDir.trim().length > 0));

// App catalog from the injected service; loaded once on mount (same cadence as
// the old parent-side load). Empty catalog hides the control (see template).
const catalog = ref<OpenInAppEntry[]>([]);
onMounted(async () => {
  catalog.value = openInService ? await openInService.catalog() : [];
});

const visibleTargets = computed(() => catalog.value);

// ---------------------------------------------------------------------------
// Target selection: the chosen app (shared reactive ref — the settings
// dropdown writes the same key), falling back to the first available one.
// ---------------------------------------------------------------------------
const selectedTargetId = useDefaultOpenInTarget();

const quickTargetId = computed(() =>
  resolveOpenInTarget(visibleTargets.value.map((t) => t.id), selectedTargetId.value),
);

const quickTargetLabel = computed(
  () => visibleTargets.value.find((t) => t.id === quickTargetId.value)?.label ?? null,
);

/** Icon URL for the pill's left half; '' when nothing can be resolved. */
const quickTargetIcon = computed(() =>
  quickTargetId.value === null || !openInService ? '' : openInService.icon(quickTargetId.value),
);

const quickTooltipText = computed(() =>
  quickTargetLabel.value === null
    ? t('header.openInEditor')
    : t('header.openInApp', { app: quickTargetLabel.value }),
);

function executeOpen(id: string): void {
  if (!hasWorkDir.value || !openInService) return;
  // Fire and forget — service implementations absorb and report their own
  // failures (native bridge returns false, daemon logs an operation failure).
  void openInService.open(id, { path: props.workDir! });
}

function handleOpenTarget(id: string): void {
  // Picking an item both opens with it and selects it — the same key the
  // settings dropdown writes, so the pill and settings stay in sync.
  saveDefaultOpenInTarget(id);
  closeMenu();
  executeOpen(id);
}

function handleQuickOpen(): void {
  // Quick open only acts on the resolved target — it must NOT persist it.
  // Only an explicit pick (a menu item or the settings select) pins a
  // selection; otherwise the first quick open would freeze the "auto"
  // behavior (first available app) forever, even after installing editors.
  const id = quickTargetId.value;
  if (id !== null) executeOpen(id);
}

// ---------------------------------------------------------------------------
// Dropdown menu (hand-rolled positioning, same pattern as ChatHeader's menu)
// ---------------------------------------------------------------------------
const menuOpen = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || triggerRef.value?.contains(target)) return;
  closeMenu();
}

function onScrollResize(): void {
  closeMenu();
}

// While the menu is open, swallow Escape in the capture phase: the
// ConversationPane listens for keydown on document in the bubble phase and
// reads any Escape during a running turn as "interrupt the prompt". Capture
// runs first, so Esc here only closes the menu.
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
  document.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', onScrollResize);
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
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', onScrollResize);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', onScrollResize);
});

const copiedPath = ref(false);
async function copyPath(): Promise<void> {
  if (!props.workDir) return;
  const ok = await copyTextToClipboard(props.workDir);
  if (!ok) return;
  copiedPath.value = true;
  setTimeout(() => { copiedPath.value = false; }, 1200);
}
</script>

<template>
  <!-- Empty catalog = the no-bridge degradation: hide the whole control. -->
  <div v-if="visibleTargets.length > 0" class="open-in" :class="{ open: menuOpen }">
    <Tooltip :text="quickTooltipText">
      <button
        type="button"
        class="open-in-main"
        :disabled="!hasWorkDir"
        :aria-label="quickTooltipText"
        @click.stop="handleQuickOpen"
      >
        <img v-if="quickTargetIcon !== ''" class="open-in-icon" :src="quickTargetIcon" alt="" />
        <Icon v-else name="external-link" size="sm" />
      </button>
    </Tooltip>
    <span class="open-in-sep" aria-hidden="true" />
    <Tooltip :text="t('header.chooseOpenApp')">
      <button
        ref="triggerRef"
        type="button"
        class="open-in-caret"
        :disabled="!hasWorkDir"
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
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}
/* The macOS chat header is a window-drag region whose scoped `no-drag` rule
   cannot reach into this component — carve the whole control out here, or
   real mouse presses start a window drag instead of clicking. */
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
/* IconButton contract (focus ring) replicated on the segmented halves — see
   the DesignSystemView exception entry for this control. */
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
  width: 0.5px;
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
