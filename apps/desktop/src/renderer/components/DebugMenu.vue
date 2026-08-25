<!-- apps/desktop/src/renderer/components/DebugMenu.vue -->
<!-- Unified debug entry (desktop-only, dev builds / Kimi Code Canary): one
     sidebar pill that merges the old Canary badge and the PR 预览 pill. The
     dropdown carries the PR preview entry (its dialog lives in the pill-less
     PrPreviewIndicator mounted here) plus the canary update actions (check /
     two-step-less trigger with confirm / view workflow). Hidden on stable
     builds and plain web — same gate as the canary channel
     (useCanaryChannel().enabled). Desktop-only file, not synced to web
     (docs/native-todos.md). -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem, Spinner } from '@moonshot-ai/app-ui';
import { useCanaryChannel, useConfirmDialog } from '@moonshot-ai/app-client/composables';
import PrPreviewIndicator from './PrPreviewIndicator.vue';
import type { PrPreviewState } from '../lib/prPreview';

const { t } = useI18n();
const { confirm } = useConfirmDialog();
const canary = useCanaryChannel();

// --- build info (version · commit · exact build time) -------------------------
// Injected at bundle time by the vite preset (__KIMI_* defines); the commit
// links out to GitHub when known.
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

// --- pill-less PR preview dialog, driven from the menu ----------------------

const previewRef = ref<{ open: () => void; state: PrPreviewState } | null>(null);

const previewBusy = computed(() => {
  const phase = previewRef.value?.state.phase;
  return phase === 'fetching' || phase === 'installing' || phase === 'building';
});
const previewActive = computed(() => previewRef.value?.state.phase === 'active');

function openPrPreview(): void {
  closeMenu();
  previewRef.value?.open();
}

// --- canary update actions ----------------------------------------------------

const checking = ref(false);
const triggering = ref(false);

/** Result feedback is a one-button dialog (no inline area in a menu). */
async function showResult(title: string, message: string): Promise<void> {
  await confirm({ title, message, confirmLabel: t('common.close'), variant: 'primary' });
}

async function onCheck(): Promise<void> {
  if (checking.value) return;
  closeMenu();
  checking.value = true;
  try {
    const result = await canary.check();
    switch (result.outcome) {
      case 'available':
        // The sidebar update pill lights up by itself — nothing to add.
        break;
      case 'latest':
        await showResult(t('settings.canaryUpdate'), t('settings.canaryLatest'));
        break;
      case 'gh-missing':
        await showResult(t('settings.canaryUpdate'), t('settings.canaryGhMissing'));
        break;
      case 'gh-unauthenticated':
        await showResult(t('settings.canaryUpdate'), t('settings.canaryGhUnauthenticated'));
        break;
      case 'error':
        await showResult(t('settings.canaryUpdate'), t('settings.canaryFailed'));
        break;
    }
  } finally {
    checking.value = false;
  }
}

async function onTrigger(): Promise<void> {
  if (triggering.value) return;
  closeMenu();
  const ok = await confirm({
    title: t('settings.canaryTrigger'),
    message: t('settings.canaryTriggerHint'),
    confirmLabel: t('settings.canaryTriggerBtn'),
    variant: 'primary',
  });
  if (!ok) return;
  triggering.value = true;
  try {
    const result = await canary.triggerBuild();
    await showResult(
      t('settings.canaryTrigger'),
      result.ok ? t('settings.canaryTriggerDone') : t('settings.canaryTriggerFailed', { error: result.error }),
    );
  } finally {
    triggering.value = false;
  }
}

function onViewWorkflow(): void {
  closeMenu();
  if (canary.actionsUrl.value !== '') {
    window.open(canary.actionsUrl.value, '_blank', 'noopener');
  }
}

// --- dropdown plumbing (Sidebar 的 backend menu 同款定位) ----------------------

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

const pillBusy = computed(() => previewBusy.value || checking.value || triggering.value);

/** Pill label: the branch the bundle was built from (injected at build time;
 *  'main' for canary CI builds, the checkout's branch in dev), 'debug' when
 *  unknown. */
const branchLabel =
  typeof __KIMI_BRANCH__ === 'string' && __KIMI_BRANCH__.trim() !== '' ? __KIMI_BRANCH__.trim() : 'debug';
</script>

<template>
  <span v-if="canary.enabled.value" class="dbg">
    <button
      class="dbg-pill"
      :class="{ 'is-preview-active': previewActive }"
      type="button"
      :aria-label="branchLabel"
      @click="toggleMenu"
    >
      <Spinner v-if="pillBusy" size="xs" />
      <Icon v-else class="dbg-pill-icon" name="flask" size="sm" />
      <span class="dbg-pill-text">{{ branchLabel }}</span>
    </button>

    <Teleport to="body">
      <Menu v-if="menuOpen" ref="menuRef" class="dbg-menu" :style="menuStyle">
        <button class="dbg-build" type="button" :disabled="commitUrl === ''" @click="openCommit">
          <span class="dbg-build-line">v{{ buildInfo.version }}<template v-if="buildInfo.short !== ''"> · {{ buildInfo.short }}</template></span>
          <span v-if="buildInfo.built !== ''" class="dbg-build-line dbg-build-time">{{ buildInfo.built }}</span>
        </button>
        <MenuItem separator />
        <MenuItem role="menuitem" @click="openPrPreview">
          <Icon name="git-pull-request" size="sm" />
          <span>{{ t('prPreview.title') }}…</span>
        </MenuItem>
        <MenuItem role="menuitem" :disabled="canary.gh.value !== 'ok'" @click="onCheck">
          <Icon name="download" size="sm" />
          <span>{{ t('settings.canaryUpdate') }}</span>
        </MenuItem>
        <MenuItem role="menuitem" :disabled="canary.gh.value !== 'ok'" @click="onTrigger">
          <Icon name="flask" size="sm" />
          <span>{{ t('settings.canaryTriggerBtn') }}</span>
        </MenuItem>
        <MenuItem role="menuitem" @click="onViewWorkflow">
          <Icon name="external-link" size="sm" />
          <span>{{ t('settings.canaryViewWorkflow') }}</span>
        </MenuItem>
      </Menu>
    </Teleport>

    <!-- The PR preview dialog lives here; its sidebar pill stays off
         (pill=false) — this component is the single entry. -->
    <PrPreviewIndicator ref="previewRef" :pill="false" />
  </span>
</template>

<style scoped>
.dbg {
  display: inline-flex;
  flex: none;
  /* The parent chrome may be a window-drag strip — the pill must stay clickable. */
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
/* Branch labels can get long (feat/xxx-yyy): cap the pill, ellipsize the
   overflow — the full label is one hover-tooltip away via aria-label. */
.dbg-pill-text {
  max-width: 16ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Serving a preview build = the "action pending" warning tint, matching the
   update pill's signal. */
.dbg-pill.is-preview-active {
  background: var(--color-warning);
}

/* Narrow header = icons only (matches the update pill's degradation). */
@container sidebar-col (max-width: 250px) {
  .dbg-pill {
    padding: var(--space-1);
  }
  .dbg-pill-text {
    display: none;
  }
}

.dbg-menu {
  position: fixed;
  z-index: var(--z-modal-dropdown);
}

/* Build info block at the menu top: two quiet lines; clickable (opens the
   commit on GitHub) when the sha is known, plain text otherwise. */
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
