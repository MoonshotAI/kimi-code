<!-- apps/kimi-web/src/components/chat/OpenInMenu.vue -->
<!-- "Open" button group for the chat header: workspace path label + quick-open
     (last used target) + dropdown caret, matching the kimi-cli/web pattern.
     Falls back to a simple icon+text "Open" button on non-mac platforms. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';
import { copyTextToClipboard } from '../../lib/clipboard';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Menu from '../ui/Menu.vue';
import MenuItem from '../ui/MenuItem.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const props = defineProps<{
  workDir?: string;
  /** Installed app IDs from the daemon; when empty/unset the menu falls back to platform defaults. */
  availableApps?: string[];
}>();

const emit = defineEmits<{
  openInApp: [appId: string];
}>();

function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) return true;
  try {
    // @ts-expect-error userAgentData is experimental
    if (navigator.userAgentData?.platform === 'macOS') return true;
  } catch { /* ignore */ }
  return false;
}

const isMac = isMacOS();

const TRAILING_SLASH = /\/+$/;
function compactPath(path: string, maxLength = 22): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const normalized = trimmed === '' ? '/' : trimmed.replace(TRAILING_SLASH, '') || '/';
  if (normalized.length <= maxLength) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return `${normalized.slice(0, maxLength - 1)}…`;
  const tail = parts.slice(-2).join('/');
  if (tail.length + 2 <= maxLength) return `…/${tail}`;
  return `…/${tail.slice(-maxLength + 2)}`;
}

const hasWorkDir = computed(() => Boolean(props.workDir && props.workDir.trim().length > 0));
const displayPath = computed(() => (hasWorkDir.value ? compactPath(props.workDir!) : 'No directory'));

const TARGETS: Array<{ id: TargetId; label: string; macOnly?: boolean }> = [
  { id: 'finder', label: 'Finder', macOnly: true },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'iterm', label: 'iTerm', macOnly: true },
  { id: 'terminal', label: 'Terminal', macOnly: true },
];

type TargetId = 'finder' | 'cursor' | 'vscode' | 'iterm' | 'terminal';

const visibleTargets = computed(() => {
  const platformTargets = TARGETS.filter((t) => !t.macOnly || isMac);
  if (!props.availableApps || props.availableApps.length === 0) {
    return platformTargets;
  }
  const available = new Set(props.availableApps);
  return platformTargets.filter((t) => available.has(t.id));
});

const LAST_TARGET_KEY = STORAGE_KEYS.openInLastTarget;
const lastTargetId = ref<TargetId | null>(null);

function loadLastTarget(): void {
  try {
    const raw = safeGetString(LAST_TARGET_KEY);
    if (raw && visibleTargets.value.some((t) => t.id === raw)) {
      lastTargetId.value = raw as TargetId;
    } else {
      lastTargetId.value = null;
    }
  } catch {
    lastTargetId.value = null;
  }
}
loadLastTarget();

function saveLastTarget(id: TargetId): void {
  try {
    safeSetString(LAST_TARGET_KEY, id);
  } catch { /* ignore */ }
  lastTargetId.value = id;
}

const lastTarget = computed(() => visibleTargets.value.find((t) => t.id === lastTargetId.value) ?? null);

// Menu state
const menuOpen = ref(false);
const triggerRef = ref<InstanceType<typeof IconButton> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || triggerRef.value?.el?.contains(target)) return;
  closeMenu();
}

function onScrollResize(): void {
  closeMenu();
}

async function openMenu(): Promise<void> {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('resize', onScrollResize);
  await nextTick();
  const btn = triggerRef.value?.el;
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
  window.removeEventListener('resize', onScrollResize);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', onScrollResize);
});

function handleOpenTarget(id: TargetId): void {
  saveLastTarget(id);
  closeMenu();
  if (hasWorkDir.value) emit('openInApp', id);
}

function handleQuickOpen(): void {
  const target = lastTarget.value ?? visibleTargets.value[0];
  if (target) handleOpenTarget(target.id);
}

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
  <div v-if="isMac" class="open-group">
    <Tooltip :text="workDir ?? ''">
      <span
        class="open-label"
        :class="{ muted: !hasWorkDir }"
      >
        <Icon name="folder" size="sm" />
        <span class="open-path">{{ displayPath }}</span>
      </span>
    </Tooltip>

    <Tooltip :text="lastTarget ? `Open in ${lastTarget.label}` : t('header.openInEditor')">
      <Button
        size="sm"
        variant="secondary"
        :disabled="!hasWorkDir"
        @click.stop="handleQuickOpen"
      >
        {{ t('header.openInEditorShort') }}
      </Button>
    </Tooltip>

    <Tooltip :text="t('header.chooseOpenApp')">
      <IconButton
        ref="triggerRef"
        size="sm"
        :class="{ open: menuOpen }"
        :disabled="!hasWorkDir"
        :label="t('header.chooseOpenApp')"
        @click.stop="openMenu"
      >
        <Icon name="chevron-down" size="sm" />
      </IconButton>
    </Tooltip>

    <Menu
      v-if="menuOpen"
      ref="menuRef"
      class="open-menu"
      :style="menuStyle"
      @click.stop
    >
      <MenuItem
        v-for="target in visibleTargets"
        :key="target.id"
        :active="target.id === lastTargetId"
        @click="handleOpenTarget(target.id)"
      >
        <span class="om-label">{{ target.label }}</span>
        <span v-if="target.id === lastTargetId" class="om-last">Last used</span>
      </MenuItem>
      <MenuItem separator />
      <MenuItem @click="copyPath">
        {{ copiedPath ? t('header.copied') : t('header.copyPath') }}
      </MenuItem>
    </Menu>
  </div>

  <!-- Non-mac fallback: maintain the previous simple open-in-editor button -->
  <Tooltip :text="t('header.openInEditor')">
    <button
      v-else
      type="button"
      class="open-fallback"
      @click="emit('openInApp', 'vscode')"
    >
      <Icon name="external-link" size="sm" />
      <span class="open-fallback-label">{{ t('header.openInEditorShort') }}</span>
    </button>
  </Tooltip>
</template>

<style scoped>
.open-group {
  display: inline-flex;
  align-items: center;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg);
  font-family: var(--mono);
  font-size: var(--text-base);
}
.open-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  color: var(--dim);
  max-width: 180px;
}
.open-label.muted { color: var(--muted); }
.open-label svg { flex: none; }
.open-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.open-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
.om-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.om-last {
  flex: none;
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
}

.open-fallback {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--dim);
  font-family: var(--sans);
  font-size: var(--ui-font-size-xs);
  padding: 0;
  cursor: pointer;
}
.open-fallback:hover { color: var(--color-text); }
.open-fallback svg { flex: none; }

@media (max-width: 980px) {
  .open-fallback-label,
  .open-path,
  .open-quick { display: none; }
}
@media (max-width: 640px) {
  .open-group,
  .open-fallback { display: none; }
}
</style>
