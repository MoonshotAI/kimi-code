<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import { useCanaryChannel, useUpdateStatus, useConfirmDialog } from '@moonshot-ai/app-client/composables';

const { t } = useI18n();
const { confirm } = useConfirmDialog();
const canary = useCanaryChannel();

const buildInfo = (() => {
  const version = typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim() !== '' ? __KIMI_CLIENT_VERSION__ : '';
  const sha = typeof __KIMI_COMMIT_SHA__ === 'string' ? __KIMI_COMMIT_SHA__ : '';
  let built = '';
  if (typeof __KIMI_BUILD_TIME__ === 'string' && __KIMI_BUILD_TIME__.trim() !== '') {
    const d = new Date(__KIMI_BUILD_TIME__);
    if (!Number.isNaN(d.getTime())) {
      built = d.toLocaleString();
    }
  }
  return { version, sha, short: sha === '' ? '' : sha.slice(0, 8), built };
})();

const commitUrl = buildInfo.sha === '' ? '' : `https://github.com/MoonshotAI/kimi-code-app/commit/${buildInfo.sha}`;

function openCommit(): void {
  if (commitUrl === '') return;
  closeMenu();
  window.open(commitUrl, '_blank', 'noopener');
}

const checking = ref(false);

const updateTracker = useUpdateStatus();

async function showResult(title: string, message: string): Promise<void> {
  await confirm({ title, message, confirmLabel: t('common.close'), variant: 'primary' });
}

async function onCheck(): Promise<void> {
  if (checking.value) return;
  closeMenu();
  checking.value = true;
  try {
    const result = await updateTracker.check();
    switch (result.outcome) {
      case 'available':
        break;
      case 'latest':
        await showResult(t('settings.canaryUpdate'), t('settings.updateCheckLatest'));
        break;
      case 'unsupported':
        await showResult(t('settings.canaryUpdate'), t('settings.updateCheckUnsupported'));
        break;
      case 'error':
        await showResult(t('settings.canaryUpdate'), t('settings.updateCheckFailed'));
        break;
    }
  } finally {
    checking.value = false;
  }
}

async function onImportStable(): Promise<void> {
  closeMenu();
  const ok = await confirm({
    title: t('settings.canaryImportStableTitle'),
    message: t('settings.canaryImportStableHint'),
    confirmLabel: t('settings.canaryImportStableBtn'),
    variant: 'primary',
  });
  if (!ok) return;
  const result = await canary.importStableSettings();
  switch (result.status) {
    case 'relaunching':
      break;
    case 'cancelled':
      break;
    case 'stable-running':
      await showResult(t('settings.canaryImportStableTitle'), t('settings.canaryImportStableRunning'));
      break;
    case 'no-stable-data':
      await showResult(t('settings.canaryImportStableTitle'), t('settings.canaryImportStableNoData'));
      break;
    case 'unavailable':
      break;
    case 'error':
      await showResult(t('settings.canaryImportStableTitle'), t('settings.canaryImportStableFailed', { error: result.error ?? '' }));
      break;
  }
}

const menuOpen = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuRef = ref<InstanceType<typeof Menu> | null>(null);

function onDocClick(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.dbg-pill') || target.closest('.dbg-menu')) return;
  closeMenu();
}

async function toggleMenu(e: MouseEvent): Promise<void> {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  const btn = e.currentTarget as HTMLElement;
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('resize', closeMenu);
  await nextTick();
  const menu = menuRef.value?.el;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(Math.max(margin, r.left))}px`,
  };
}

function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
});

const branchLabel =
  typeof __KIMI_BRANCH__ === 'string' && __KIMI_BRANCH__.trim() !== '' ? __KIMI_BRANCH__.trim() : 'debug';
</script>

<template>
  <span v-if="canary.enabled.value" class="dbg">
    <Tooltip :text="branchLabel">
      <button class="dbg-pill" type="button" :aria-label="branchLabel" @click="toggleMenu">
        <Spinner v-if="checking" size="xs" />
        <Icon v-else class="dbg-pill-icon" name="flask" size="sm" />
        <span class="dbg-pill-text">{{ branchLabel }}</span>
      </button>
    </Tooltip>

    <Teleport to="body">
      <Menu v-if="menuOpen" ref="menuRef" class="ui-menu-floating dbg-menu" :style="menuStyle">
        <button class="dbg-build" type="button" :disabled="commitUrl === ''" @click="openCommit">
          <span v-if="buildInfo.version.includes('-canary.')" class="dbg-build-line">{{ t('settings.canaryTargetVersion', { version: buildInfo.version.split('-canary.')[0] }) }}</span>
          <span class="dbg-build-line">v{{ buildInfo.version }}<template v-if="buildInfo.short !== ''"> · {{ buildInfo.short }}</template></span>
          <span v-if="buildInfo.built !== ''" class="dbg-build-line dbg-build-time">{{ buildInfo.built }}</span>
        </button>
        <MenuItem separator />
        <MenuItem role="menuitem" :disabled="checking" @click="onCheck">
          <Icon name="download" size="sm" />
          <span>{{ t('settings.canaryUpdate') }}</span>
        </MenuItem>
        <MenuItem v-if="canary.isRealCanaryBuild.value" role="menuitem" @click="onImportStable">
          <Icon name="download" size="sm" />
          <span>{{ t('settings.canaryImportStable') }}</span>
        </MenuItem>
      </Menu>
    </Teleport>
  </span>
</template>

<style scoped>
.dbg {
  display: inline-flex;
  flex: none;
  -webkit-app-region: no-drag;
  animation: dbg-in var(--duration-base) var(--ease-out);
}
@keyframes dbg-in {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
}

.dbg-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  white-space: nowrap;
  cursor: pointer;
  transition: filter var(--duration-fast) var(--ease-out);
}
.dbg-pill:hover {
  filter: brightness(1.1);
}
.dbg-pill:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.dbg-pill-icon {
  flex: none;
  color: var(--color-text-on-accent);
}
.dbg-pill-text {
  max-width: 16ch;
  overflow: hidden;
  text-overflow: ellipsis;
}

@container sidebar-header (max-width: 300px) {
  .dbg-pill {
    padding: var(--space-1);
  }
  .dbg-pill-text {
    display: none;
  }
}

.dbg-menu {
  z-index: var(--z-modal-dropdown);
}

.dbg-build {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
  border: none;
  border-radius: var(--radius-menu-item);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.dbg-build:disabled {
  cursor: default;
}
.dbg-build:not(:disabled):hover {
  background: var(--color-hover);
}
.dbg-build:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.dbg-build-line {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.dbg-build-time {
  color: var(--color-text-faint);
}
</style>
