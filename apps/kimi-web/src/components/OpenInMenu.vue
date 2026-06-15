<!-- apps/kimi-web/src/components/OpenInMenu.vue -->
<!-- "Open" button group for the chat header: workspace path label + quick-open
     (last used target) + dropdown caret, matching the kimi-cli/web pattern.
     Falls back to a simple icon+text "Open" button on non-mac platforms. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

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

const LAST_TARGET_KEY = 'kimi-web.open-in.last-target';
const lastTargetId = ref<TargetId | null>(null);

function loadLastTarget(): void {
  try {
    const raw = localStorage.getItem(LAST_TARGET_KEY);
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
    localStorage.setItem(LAST_TARGET_KEY, id);
  } catch { /* ignore */ }
  lastTargetId.value = id;
}

const lastTarget = computed(() => visibleTargets.value.find((t) => t.id === lastTargetId.value) ?? null);

// Menu state
const menuOpen = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.contains(target) || triggerRef.value?.contains(target)) return;
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
  document.addEventListener('scroll', onScrollResize, true);
  window.addEventListener('resize', onScrollResize);
  await nextTick();
  const btn = triggerRef.value;
  const menu = menuRef.value;
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
  document.removeEventListener('scroll', onScrollResize, true);
  window.removeEventListener('resize', onScrollResize);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('scroll', onScrollResize, true);
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
  try {
    await navigator.clipboard.writeText(props.workDir);
    copiedPath.value = true;
    setTimeout(() => { copiedPath.value = false; }, 1200);
  } catch { /* ignore */ }
}
</script>

<template>
  <div v-if="isMac" class="open-group">
    <span
      class="open-label"
      :class="{ muted: !hasWorkDir }"
      :title="workDir ?? ''"
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12V5a1 1 0 0 1 1-1h2l2-2 2 2h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
        <path d="M4 10h8" />
      </svg>
      <span class="open-path">{{ displayPath }}</span>
    </span>

    <button
      type="button"
      class="open-btn open-quick"
      :disabled="!hasWorkDir"
      :title="lastTarget ? `Open in ${lastTarget.label}` : t('header.openInEditor')"
      @click.stop="handleQuickOpen"
    >
      {{ t('header.openInEditorShort') }}
    </button>

    <button
      ref="triggerRef"
      type="button"
      class="open-btn open-caret"
      :class="{ open: menuOpen }"
      :disabled="!hasWorkDir"
      :title="t('header.chooseOpenApp')"
      :aria-label="t('header.chooseOpenApp')"
      @click.stop="openMenu"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4,6 8,10 12,6" />
      </svg>
    </button>

    <div
      v-if="menuOpen"
      ref="menuRef"
      class="open-menu"
      :style="menuStyle"
      @click.stop
    >
      <button
        v-for="target in visibleTargets"
        :key="target.id"
        type="button"
        class="om-item"
        :class="{ last: target.id === lastTargetId }"
        @click.stop="handleOpenTarget(target.id)"
      >
        <span class="om-label">{{ target.label }}</span>
        <span v-if="target.id === lastTargetId" class="om-last">Last used</span>
      </button>
      <div class="om-divider" />
      <button type="button" class="om-item" @click.stop="copyPath">
        <span>{{ copiedPath ? t('header.copied') : t('header.copyPath') }}</span>
      </button>
    </div>
  </div>

  <!-- Non-mac fallback: maintain the previous simple open-in-editor button -->
  <button
    v-else
    type="button"
    class="open-fallback"
    :title="t('header.openInEditor')"
    @click="emit('openInApp', 'vscode')"
  >
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 2h5v5M14 2 7 9M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />
    </svg>
    <span class="open-fallback-label">{{ t('header.openInEditorShort') }}</span>
  </button>
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
  font-size: calc(var(--ui-font-size) - 3px);
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
.open-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: none;
  border-left: 1px solid var(--line);
  background: var(--bg);
  color: var(--dim);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.open-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.open-btn:not(:disabled):hover { background: var(--soft); color: var(--ink); }
.open-btn.open { background: var(--soft); color: var(--ink); }
.open-quick { padding: 4px 10px; }
.open-caret { padding: 4px 6px; }
.open-caret svg { flex: none; }

.open-menu {
  position: fixed;
  top: 0;
  left: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  z-index: 200;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
  min-width: 150px;
}
.om-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--ink);
  padding: 6px 12px;
}
.om-item:hover { background: var(--panel2); }
.om-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.om-last {
  flex: none;
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
}
.om-divider {
  height: 1px;
  background: var(--line);
  margin: 2px 0;
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
.open-fallback:hover { color: var(--ink); }
.open-fallback svg { flex: none; }

@media (max-width: 900px) {
  .open-fallback-label,
  .open-path,
  .open-quick { display: none; }
}
@media (max-width: 640px) {
  .open-group,
  .open-fallback { display: none; }
}
</style>
