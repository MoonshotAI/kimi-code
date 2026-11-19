<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Spinner } from '@moonshot-ai/app-ui';
import { useFollowScroll } from '@moonshot-ai/app-client/composables';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { AgentMember } from '@moonshot-ai/app-core/client/types';
import JumpToBottomPill from './JumpToBottomPill.vue';

const props = defineProps<{ member: AgentMember | null }>();

const { t } = useI18n();

const command = computed(() => {
  const raw = props.member?.prompt;
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
});

const outputLines = computed<string[]>(() => {
  const member = props.member;
  if (!member) return [];
  const placeholder = command.value !== undefined ? `$ ${command.value}` : null;
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const value of [member.text, member.outputLines?.join('\n')]) {
    const block = value?.trim();
    if (!block || seen.has(block)) continue;
    if (placeholder !== null && block === placeholder) continue;
    seen.add(block);
    blocks.push(block);
  }
  return blocks.flatMap((block) => block.split('\n'));
});

const running = computed(
  () => props.member?.status === 'running' && props.member.phase !== 'suspended',
);
const outputLoading = computed(() => props.member?.outputLoading === true);
const outputUnavailable = computed(() => props.member?.outputUnavailable === true);
const suspendedReason = computed(() =>
  props.member?.phase === 'suspended' ? props.member.suspendedReason : undefined,
);
const failed = computed(() => props.member?.status === 'failed');
const cancelled = computed(() => props.member?.status === 'cancelled');
const showStatus = computed(
  () =>
    running.value ||
    suspendedReason.value !== undefined ||
    failed.value ||
    cancelled.value,
);

const identity = computed(() => props.member?.id ?? null);
const { scroller, showJump, onScroll, jumpToBottom } = useFollowScroll(identity);
function setScroller(el: unknown): void {
  scroller.value = el instanceof HTMLElement ? el : null;
}

const copiedFor = ref<'cmd' | 'out' | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function markCopied(kind: 'cmd' | 'out'): void {
  copiedFor.value = kind;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedFor.value = null;
  }, 1400);
}
watch(identity, () => {
  copiedFor.value = null;
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
});

function copyCommand(): void {
  if (command.value === undefined) return;
  const owner = identity.value;
  void copyTextToClipboard(command.value).then((ok) => {
    if (ok && identity.value === owner) markCopied('cmd');
  });
}
function copyOutput(): void {
  if (outputLines.value.length === 0) return;
  const owner = identity.value;
  void copyTextToClipboard(outputLines.value.join('\n')).then((ok) => {
    if (ok && identity.value === owner) markCopied('out');
  });
}
</script>

<template>
  <div v-if="member" class="bp">
    <div v-if="command" class="bp-cmd-wrap">
      <div class="bp-cmd">
        <span class="bp-dollar" aria-hidden="true">$</span> {{ command }}
      </div>
      <div class="bp-actions">
        <IconButton
          class="bp-copy"
          size="sm"
          :label="copiedFor === 'cmd' ? t('tasks.copied') : t('tasks.copyCommand')"
          :tooltip="copiedFor === 'cmd' ? t('tasks.copied') : t('tasks.copyCommand')"
          @click="copyCommand"
        >
          <Icon v-if="copiedFor !== 'cmd'" name="copy" size="sm" />
          <Icon v-else name="check" size="sm" />
        </IconButton>
      </div>
    </div>
    <div class="bp-output-wrap">
      <div :ref="setScroller" class="bp-output" @scroll.passive="onScroll">
        <div class="bp-output-inner">
          <div v-for="(line, i) in outputLines" :key="i">{{ line }}</div>
          <div v-if="outputLoading && !running" class="bp-empty bp-loading">
            <Spinner size="sm" />
            <span>{{ t('tools.output.waiting') }}</span>
          </div>
          <div v-else-if="outputLines.length === 0" class="bp-empty">
            {{
              outputUnavailable
                ? t('tools.output.unavailable')
                : running
                  ? t('tools.output.waiting')
                  : t('tools.output.empty')
            }}
          </div>
        </div>
      </div>
      <div class="bp-actions">
        <IconButton
          v-if="outputLines.length > 0"
          class="bp-copy"
          size="sm"
          :label="copiedFor === 'out' ? t('tasks.copied') : t('tasks.copyOutput')"
          :tooltip="copiedFor === 'out' ? t('tasks.copied') : t('tasks.copyOutput')"
          @click="copyOutput"
        >
          <Icon v-if="copiedFor !== 'out'" name="copy" size="sm" />
          <Icon v-else name="check" size="sm" />
        </IconButton>
      </div>
      <JumpToBottomPill :show="showJump" @click="jumpToBottom" />
    </div>
    <div v-if="showStatus" class="bp-status">
      <template v-if="running">
        <Spinner size="sm" />
        <span>{{ t('tasks.running') }}</span>
      </template>
      <span v-else-if="suspendedReason !== undefined" class="bp-status-muted">{{ suspendedReason }}</span>
      <span v-else-if="failed" class="bp-status-danger">{{ t('tools.agent.status.error') }}</span>
      <span v-else class="bp-status-muted">{{ t('tools.agent.status.cancelled') }}</span>
    </div>
  </div>
</template>

<style scoped>
.bp {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  position: relative;
  background: var(--color-bg);
}

.bp-cmd,
.bp-output {
  background: var(--color-well);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) calc(var(--icon-button-sm) + var(--space-2)) var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
  overscroll-behavior: contain;
}
.bp-cmd {
  flex: none;
  max-height: calc(6 * 1lh);
  overflow-y: auto;
}

.bp-cmd-wrap {
  flex: none;
  position: relative;
}
.bp-output-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
}
.bp-output {
  height: 100%;
  overflow-y: auto;
}

.bp-actions {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  z-index: var(--z-sticky);
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.bp-cmd-wrap:hover .bp-actions,
.bp-output-wrap:hover .bp-actions,
.bp-actions:focus-within {
  opacity: 1;
}
@media (hover: none) {
  .bp-actions {
    opacity: 1;
  }
}
.bp-copy {
  background: var(--color-well);
  border-color: var(--color-line);
}

.bp-dollar {
  color: var(--color-text-faint);
  user-select: none;
}

.bp-empty {
  color: var(--color-text-faint);
  font-style: italic;
}
.bp-loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.bp-status {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
.bp-status-muted {
  color: var(--color-text-muted);
}
.bp-status-danger {
  color: var(--color-danger);
}
</style>
