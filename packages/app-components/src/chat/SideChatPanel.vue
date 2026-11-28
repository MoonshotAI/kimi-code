<script lang="ts">
import { reactive } from 'vue';
import type { ScrollSnapshot } from '@moonshot-ai/app-core/lib';

const sideChatInflight = reactive(new Set<string>());
const sideChatScrollSnapshots = new Map<string, ScrollSnapshot>();
</script>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatPane from './ChatPane.vue';
import Composer from '../composer/Composer.vue';
import JumpToBottomPill from './JumpToBottomPill.vue';
import { EmptyState, Icon } from '@moonshot-ai/app-ui';
import { sideChatDrafts } from '@moonshot-ai/app-client/client';
import { persistComposerDraftSnapshot } from '@moonshot-ai/app-client/lib';
import { useEscInterrupt, usePanelScroll } from '@moonshot-ai/app-client/composables';
import { draftAttachmentsStorageKey, draftStorageKey, safeGetJson, safeGetString, type TranscriptLayout } from '@moonshot-ai/app-core/lib';
import { FetchTurnFileChangesKey } from '@moonshot-ai/app-client/contracts';
import { PinScrollKey } from '@moonshot-ai/app-core/contracts';
import type { ChatTurn, OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import type { PromptAttachment, SideChatTurnError } from '@moonshot-ai/app-client/client';
import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';

const props = defineProps<{
  turns: ChatTurn[];
  running: boolean;
  sending: boolean;
  agentId: string;
  turnFailed?: boolean;
  turnError?: SideChatTurnError | null;
  cwd?: string;
  onSend: (text: string, attachments?: PromptAttachment[], snapshot?: ComposerDocumentSnapshot) => Promise<boolean>;
  onInterrupt?: () => Promise<unknown> | void;
}>();

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
}>();

const { t } = useI18n();

const SCROLL_FADE_PX = 48;

const composerRef = ref<InstanceType<typeof Composer> | null>(null);

const composerH = ref(0);
const panelScroll = usePanelScroll({ identity: () => props.agentId, snapshots: sideChatScrollSnapshots, applyLayout: applyDockLayout });
const bodyRef = panelScroll.scroller;
const showJump = panelScroll.showJump;
const onBodyScroll = panelScroll.onScroll;

function jumpToBottom(): void {
  panelScroll.follow();
}

function applyDockLayout(layout: TranscriptLayout): void {
  if (layout.dockHeight === composerH.value) return;
  composerH.value = layout.dockHeight;
  const el = bodyRef.value;
  if (!el) return;
  el.style.setProperty('--sc-composer-h', `${layout.dockHeight}px`);
  el.style.setProperty('--sc-dock-space', `${layout.dockHeight > 0 ? layout.dockHeight + SCROLL_FADE_PX : 0}px`);
}

const composerEl = panelScroll.dock;

const submitting = computed(() => sideChatInflight.has(props.agentId));
const sideChatWorking = computed(() => props.running || props.sending);

const { armed: escInterruptArmed, press: pressEscInterrupt, reset: resetEscInterrupt } = useEscInterrupt({
  sessionId: () => props.agentId,
  working: () => sideChatWorking.value,
  interrupt: handleInterrupt,
});

function handleInterrupt(): void {
  resetEscInterrupt();
  void props.onInterrupt?.();
}

function onRootKeydown(event: KeyboardEvent): void {
  if (
    event.key !== 'Escape' ||
    event.defaultPrevented ||
    event.isComposing ||
    !sideChatWorking.value ||
    composerRef.value?.anyPopupOpen === true
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  pressEscInterrupt();
}

type ComposerSubmitPayload = {
  text: string;
  restoreText: string;
  attachments: PromptAttachment[];
  restoreEntries: AttachmentEntry[];
  snapshot?: ComposerDocumentSnapshot;
};

function scopeDraftIsEmpty(scope: string): boolean {
  const text = safeGetString(draftStorageKey(scope));
  if (text !== null && text !== '') return false;
  const entries = safeGetJson<unknown>(draftAttachmentsStorageKey(scope));
  return !Array.isArray(entries) || entries.length === 0;
}

function restoreSubmitSnapshot(payload: ComposerSubmitPayload): void {
  const composer = composerRef.value;
  if (composer === null || composer === undefined) {
    const scope = `sidechat:${props.agentId}`;
    if (scopeDraftIsEmpty(scope)) {
      persistComposerDraftSnapshot(scope, payload.restoreText, payload.restoreEntries, payload.snapshot);
    }
    return;
  }
  if (composer.isEmpty() !== true) return;
  composer.loadForEdit(payload.restoreText, payload.snapshot);
  if (payload.snapshot === undefined) composer.restoreDraftEntries(payload.restoreEntries);
}

async function onComposerSubmit(payload: ComposerSubmitPayload): Promise<void> {
  if (submitting.value || props.running || props.sending) {
    restoreSubmitSnapshot(payload);
    return;
  }
  sideChatInflight.add(props.agentId);
  jumpToBottom();
  try {
    const sent = await props.onSend(payload.text, payload.attachments, payload.snapshot);
    if (!sent) {
      restoreSubmitSnapshot(payload);
      return;
    }
  } finally {
    sideChatInflight.delete(props.agentId);
  }
}

function onResumeTurn(): void {
  jumpToBottom();
  void props.onSend(t('conversation.turnFailedResumeText'));
}

function seedDraftFromHandoff(agentId: string): void {
  const seed = sideChatDrafts.get(agentId);
  if (seed === undefined) return;
  sideChatDrafts.delete(agentId);
  composerRef.value?.loadForEdit(seed);
}

onMounted(() => {
  seedDraftFromHandoff(props.agentId);
});

watch(() => props.agentId, (agentId) => {
  seedDraftFromHandoff(agentId);
});

provide(PinScrollKey, (el: HTMLElement, ms?: number) => panelScroll.hold(el, ms));

provide(FetchTurnFileChangesKey, undefined);

function focusInput(): void {
  composerRef.value?.focus();
}

defineExpose({ focusInput });
</script>

<template>
  <div class="sc" @keydown="onRootKeydown">
    <div ref="bodyRef" class="sc-body" data-panel-content @scroll.passive="onBodyScroll">
      <EmptyState v-if="turns.length === 0" class="sc-empty" :title="t('sideChat.title')" :hint="t('sideChat.empty')">
        <template #icon>
          <Icon name="side-chat" size="lg" />
        </template>
      </EmptyState>
      <ChatPane
        v-else
        :turns="turns"
        :approvals="[]"
        :turn-active="running"
        :working="sending || running"
        :turn-failed="turnFailed"
        :turn-error="turnError ?? null"
        :turn-files-interactive="false"
        :selection-actions="false"
        :undoable="false"
        :cwd="props.cwd"
        @open-media="emit('openMedia', $event)"
        @resume-turn="onResumeTurn"
      />
      <div v-if="turns.length > 0" class="sc-dock-space" aria-hidden="true" />
    </div>

    <div ref="composerEl" class="sc-composer">
      <Composer
        ref="composerRef"
        variant="side-chat"
        :working-override="sideChatWorking"
        :interrupt-armed="escInterruptArmed"
        :draft-scope-key="`sidechat:${agentId}`"
        :placeholder-text="t('sideChat.placeholder')"
        :submit-disabled="running || sending"
        @submit="onComposerSubmit"
        @interrupt="handleInterrupt"
      />
    </div>

    <div class="sc-jump" :style="{ bottom: `${composerH}px` }">
      <JumpToBottomPill :show="showJump" @click="jumpToBottom()" />
    </div>
  </div>
</template>

<style scoped>
.sc {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
  position: relative;
}
.sc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  --sc-composer-h: 0px;
  mask-image: linear-gradient(
    to bottom,
    black calc(100% - var(--sc-composer-h) - 48px),
    transparent calc(100% - var(--sc-composer-h))
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    black calc(100% - var(--sc-composer-h) - 48px),
    transparent calc(100% - var(--sc-composer-h))
  );
}
.sc-empty {
  min-height: calc(100% - var(--sc-dock-space, 0px));
}
.sc-dock-space {
  height: var(--sc-dock-space, 0px);
}
.sc-empty :deep(.ui-empty__icon) {
  color: var(--color-accent);
}
.sc-empty :deep(.ui-empty__icon svg) {
  width: 28px;
  height: 28px;
}
.sc-empty :deep(.ui-empty__title) {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.sc-empty :deep(.ui-empty__hint) {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  white-space: pre-line;
}

.sc-composer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-sticky);
}

.sc-jump {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  z-index: var(--z-sticky);
  pointer-events: none;
}
.sc-jump :deep(.jump-pill) {
  pointer-events: auto;
}
</style>
