<!-- apps/web/src/components/chat/AgentDetailPanel.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, provide, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, IconButton, Menu, MenuItem, PanelHeader, openDialogCount } from '@moonshot-ai/app-ui';

import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useFollowScroll } from '@moonshot-ai/app-client/composables';
import type { AgentMember, ChatTurn, FilePreviewRequest, OpenMediaRequest } from '../../types';
import type { TurnFileChange } from '../chatTurnRendering';
import ChatPane from './ChatPane.vue';
import OutputPanel from './tool-calls/OutputPanel.vue';

const props = defineProps<{
  member: AgentMember;
  turns: ChatTurn[];
  running: boolean;
  loading: boolean;
  loadError: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
}>();
const emit = defineEmits<{
  close: [];
  loadOlderMessages: [];
  openAgent: [agentId: string];
  openFile: [target: FilePreviewRequest];
  openMedia: [payload: OpenMediaRequest];
  openTurnDiff: [change: TurnFileChange];
}>();
const { t } = useI18n();

// Bash details carry their verbatim command on member.prompt and the terminal
// output on outputLines — both live behind the header's copy menu, as the old
// inline detail had it.
const copied = ref<'command' | 'output' | 'all' | null>(null);
// The clipboard's "output": the detail body's real output blocks — answer
// text, tool lines, result — but NOT the prompt or its `$ <command>`
// placeholder preview: a bash task's command has its own copy button next
// door, so the clipboard must not mix command into output. Also gates the
// button: a placeholder-only preview is not output.
const copyableOutput = computed(() => {
  const command = props.member.prompt?.trim();
  const placeholder = command ? `$ ${command}` : null;
  return fallbackOutput.value.filter((block) => block !== command && block !== placeholder).join('\n');
});
// A second successful copy (another menu item, or a fast re-click) retires
// the previous hide timer — otherwise the older timeout still fires and
// clears the newer check early.
let copyTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on task switch, so a late clipboard resolve from the previous task
// never lands its copied check on the new one.
let copySerial = 0;
function copyMember(what: 'command' | 'output' | 'all'): void {
  const text =
    what === 'command'
      ? props.member.prompt
      : what === 'output'
        ? copyableOutput.value
        : [props.member.prompt?.trim(), copyableOutput.value].filter(Boolean).join('\n\n');
  if (!text) return;
  const serial = copySerial;
  void copyTextToClipboard(text).then((ok) => {
    if (!ok || serial !== copySerial) return;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copied.value = what;
    copyTimer = setTimeout(() => {
      copyTimer = null;
      copied.value = null;
    }, 1400);
  });
}

// ---------------------------------------------------------------------------
// Copy dropdown: one header button opens a labelled menu (command / output /
// all) instead of two identical icons only a tooltip could tell apart — and
// one less button competing for the header's limited width. Teleported to
// <body> and positioned from the trigger: the preview panel clips and
// captures descendants (overflow + backdrop-filter), so an in-panel menu
// would be squeezed by the container (same constraint as dock/FilterControl).
// ---------------------------------------------------------------------------
// Touch devices (no hover) get the §03 lg 44px trigger and ≥44px menu rows;
// desktop keeps the compact sm / md sizes (same rule as dock/FilterControl).
const hoverless = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;
const menuRowSize = hoverless ? 'lg' : 'md';
const copyTriggerSize = hoverless ? 'lg' : 'sm';

const copyMenuOpen = ref(false);
const copyTriggerRef = ref<ComponentPublicInstance | null>(null);
const copyMenuBoxRef = ref<HTMLElement | null>(null);
const copyMenuStyle = ref<Record<string, string>>({ left: '0px', top: '0px' });

function copyTriggerEl(): HTMLElement | null {
  return (copyTriggerRef.value?.$el as HTMLElement | undefined) ?? null;
}

async function toggleCopyMenu(): Promise<void> {
  if (copyMenuOpen.value) {
    closeCopyMenu();
    return;
  }
  copyMenuOpen.value = true;
  await nextTick();
  positionCopyMenu();
  focusCopyMenuItem();
  window.addEventListener('mousedown', onCopyWindowPointerDown, true);
  window.addEventListener('keydown', onCopyWindowKeydown, true);
  window.addEventListener('resize', positionCopyMenu);
  window.addEventListener('scroll', positionCopyMenu, true);
}

function closeCopyMenu(options?: { refocus?: boolean }): void {
  copyMenuOpen.value = false;
  window.removeEventListener('mousedown', onCopyWindowPointerDown, true);
  window.removeEventListener('keydown', onCopyWindowKeydown, true);
  window.removeEventListener('resize', positionCopyMenu);
  window.removeEventListener('scroll', positionCopyMenu, true);
  // Keyboard closes and selections hand focus back to the trigger; outside
  // pointer presses deliberately don't (the user's click target owns focus).
  if (options?.refocus) copyTriggerEl()?.focus();
}

// Keyboard open: move focus into the menu — the first ENABLED item (the
// output item stays disabled until output exists).
function focusCopyMenuItem(): void {
  const box = copyMenuBoxRef.value;
  if (!box) return;
  box.querySelector<HTMLElement>('.ui-menu-item:not(:disabled)')?.focus();
}

// Tabbing away closes the menu — the focus is moving on deliberately, so it
// is never yanked back to the trigger.
function onCopyFocusLeave(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && (copyMenuBoxRef.value?.contains(next) || copyTriggerEl()?.contains(next))) return;
  closeCopyMenu();
}

// Arrow keys on the trigger open the menu straight into the items.
function onCopyTriggerArrow(): void {
  if (!copyMenuOpen.value) void toggleCopyMenu();
}

function onCopyMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = Array.from(
    copyMenuBoxRef.value?.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)') ?? [],
  );
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'ArrowDown'
      ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

function positionCopyMenu(): void {
  const trigger = copyTriggerEl();
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const rootStyle = getComputedStyle(document.documentElement);
  const edge = Number.parseFloat(rootStyle.getPropertyValue('--space-2')) || 0;
  const gap = Number.parseFloat(rootStyle.getPropertyValue('--space-1')) || 0;
  const menuWidth = copyMenuBoxRef.value?.offsetWidth ?? 0;
  // Right-align under the trigger: the header button sits near the panel's
  // right edge, so anchoring on its left could push the menu off-screen.
  const left = Math.max(edge, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - edge));
  const menuHeight = copyMenuBoxRef.value?.offsetHeight ?? 0;
  // Prefer opening downward; flip up when the viewport bottom is too close.
  if (rect.bottom + gap + menuHeight <= window.innerHeight - edge) {
    copyMenuStyle.value = { left: `${left}px`, top: `${rect.bottom + gap}px` };
  } else {
    copyMenuStyle.value = { left: `${left}px`, bottom: `${window.innerHeight - rect.top + gap}px` };
  }
}

function onCopyWindowPointerDown(event: MouseEvent): void {
  const target = event.target as Node | null;
  if (!target) return;
  if (copyMenuBoxRef.value?.contains(target)) {
    // Presses inside the menu are consumed HERE (window capture runs before
    // the dock's document-capture outside-press) so picking an item never
    // dismisses the dock work panel underneath.
    event.stopImmediatePropagation();
    return;
  }
  if (copyTriggerEl()?.contains(target)) return; // the trigger's click toggles
  closeCopyMenu();
}

function onCopyWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // Consume the key: the App's document-capture handler would otherwise also
  // fire and close the whole detail panel behind the menu (it checks
  // defaultPrevented; stopImmediatePropagation covers same-element capture
  // listeners registered later). One Escape closes one layer.
  event.preventDefault();
  event.stopImmediatePropagation();
  closeCopyMenu({ refocus: true });
}

function copyMemberAndClose(what: 'command' | 'output' | 'all'): void {
  copyMember(what);
  closeCopyMenu({ refocus: true });
}

// A modal layer (settings, login, …) outranks the menu: close before its
// Escape reaches our window listener.
watch(openDialogCount, (count) => {
  if (count > 0 && copyMenuOpen.value) closeCopyMenu();
});

const identity = computed(() => props.member.id);
const { scroller, following, onScroll, pinScroll } = useFollowScroll(identity);

// A task switch retires the previous task's copied check and its hide timer.
watch(identity, () => {
  closeCopyMenu();
  copySerial++;
  if (copyTimer !== null) clearTimeout(copyTimer);
  copyTimer = null;
  copied.value = null;
});

// Mounting the transcript (with its Markdown renders) while the panel's width
// change has not been laid out yet makes mount-time width measurements force
// a whole-page layout. rAF callbacks run before the frame's layout, so wait
// two frames — one full rendering opportunity — before mounting content.
const contentReady = ref(false);
let readyFrame: number | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;

function cancelReadySchedule(): void {
  if (readyFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(readyFrame);
  }
  if (readyTimer !== null) clearTimeout(readyTimer);
  readyFrame = null;
  readyTimer = null;
}

watch(identity, () => {
  contentReady.value = false;
  cancelReadySchedule();
  const done = (): void => {
    cancelReadySchedule();
    contentReady.value = true;
  };
  if (typeof requestAnimationFrame === 'function') {
    readyFrame = requestAnimationFrame(() => {
      readyFrame = requestAnimationFrame(done);
    });
  } else {
    readyTimer = setTimeout(done, 32);
  }
}, { immediate: true });
onBeforeUnmount(() => {
  cancelReadySchedule();
  if (copyMenuOpen.value) closeCopyMenu();
});
const fallbackOutput = computed(() => {
  const seen = new Set<string>();
  const output: string[] = [];
  // A `$ <command>` placeholder preview is not output — the verbatim command
  // already leads this list, so the placeholder form is skipped entirely.
  const command = props.member.prompt?.trim();
  const placeholder = command ? `$ ${command}` : null;
  for (const value of [
    // The task's own brief first — a bash task's verbatim command rides this
    // field, and without it the fallback loses the command entirely.
    props.member.prompt,
    props.member.suspendedReason,
    props.member.text,
    props.member.outputLines?.join('\n'),
    props.member.summary,
  ]) {
    const block = value?.trim();
    if (!block || seen.has(block)) continue;
    if (placeholder !== null && block === placeholder) continue;
    seen.add(block);
    output.push(block);
  }
  return output;
});

provide('pinScroll', () => {
  if (scroller.value) pinScroll();
});

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return t('tools.swarm.phaseQueued');
    case 'working': return t('tools.swarm.phaseWorking');
    case 'suspended': return t('tools.swarm.phaseSuspended');
    case 'completed': return t('tools.swarm.phaseCompleted');
    case 'failed': return t('tools.swarm.phaseFailed');
    case 'cancelled': return t('tools.swarm.phaseCancelled');
  }
}

// Subtitle: agent type · bound model (friendly name) · effort (concrete levels only).
const modelDisplay = inject<(alias: string | undefined) => string | undefined>('modelDisplay');
const subagentEffort = inject<(effort: string | undefined) => string | undefined>('subagentEffort');
const subtitle = computed(() => {
  const parts = [
    props.member.subagentType,
    modelDisplay?.(props.member.model),
    subagentEffort?.(props.member.thinkingEffort),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
});
</script>

<template>
  <div class="agent-panel">
    <PanelHeader
      :title="member.name"
      :subtitle="subtitle"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm">{{ phaseLabel(member.phase) }}</Badge>
      <template v-if="member.prompt || copyableOutput">
        <IconButton
          ref="copyTriggerRef"
          :size="copyTriggerSize"
          :class="{ 'copy-menu-open': copyMenuOpen }"
          :label="t('tasks.copy')"
          :tooltip="t('tasks.copy')"
          aria-haspopup="menu"
          :aria-expanded="copyMenuOpen"
          @click="toggleCopyMenu"
          @keydown.down.prevent="onCopyTriggerArrow"
          @keydown.up.prevent="onCopyTriggerArrow"
          @focusout="onCopyFocusLeave"
        >
          <Icon :name="copied ? 'check' : 'copy'" size="sm" />
        </IconButton>
        <Teleport to="body">
          <div
            v-if="copyMenuOpen"
            ref="copyMenuBoxRef"
            class="copy-menu"
            :style="copyMenuStyle"
            @keydown="onCopyMenuKeydown"
            @focusout="onCopyFocusLeave"
          >
            <Menu>
              <MenuItem v-if="member.prompt" :size="menuRowSize" @click="copyMemberAndClose('command')">
                <Icon name="terminal" size="sm" />
                <span>{{ t('tasks.copyCommand') }}</span>
              </MenuItem>
              <MenuItem :disabled="!copyableOutput" :size="menuRowSize" @click="copyMemberAndClose('output')">
                <Icon name="file-text" size="sm" />
                <span>{{ t('tasks.copyOutput') }}</span>
              </MenuItem>
              <MenuItem separator />
              <MenuItem :size="menuRowSize" @click="copyMemberAndClose('all')">
                <Icon name="copy" size="sm" />
                <span>{{ t('tasks.copyAll') }}</span>
              </MenuItem>
            </Menu>
          </div>
        </Teleport>
      </template>
    </PanelHeader>
    <div ref="scroller" class="agent-transcript" @scroll.passive="onScroll">
      <template v-if="contentReady">
        <div
          v-if="turns.length === 0 && !loading && (loadError || fallbackOutput.length > 0)"
          class="agent-fallback"
        >
          <div v-if="loadError" class="agent-error">{{ t('tasks.transcriptLoadError') }}</div>
          <OutputPanel v-if="fallbackOutput.length > 0" :lines="fallbackOutput" />
        </div>
        <ChatPane
          v-else
          :turns="turns"
          :turn-active="running"
          :session-loading="loading && turns.length === 0"
          :has-more-messages="hasMore"
          :loading-more="loadingMore"
          :loading-more-error="loadMoreError"
          :is-following="following"
          read-only
          inspector
          @load-older-messages="emit('loadOlderMessages')"
          @open-agent="emit('openAgent', $event)"
          @open-file="emit('openFile', $event)"
          @open-media="emit('openMedia', $event)"
          @open-turn-diff="emit('openTurnDiff', $event)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.agent-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}
.agent-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.agent-transcript :deep(.think-body),
.agent-transcript :deep(.ar-body),
.agent-transcript :deep(.tf-body),
.agent-transcript :deep(.bb),
.agent-transcript :deep(.tl-body) {
  transition: none;
}
.agent-error {
  color: var(--color-danger);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}

/* position: fixed + left/top from the trigger rect; teleported to body so the
   preview panel's overflow and backdrop-filter never clip or squeeze it. */
.copy-menu {
  position: fixed;
  z-index: var(--z-dropdown);
}

.agent-fallback {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}
</style>
