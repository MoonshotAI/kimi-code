<!-- In-transcript notice for a task notification (a hidden `<notification>`
     user message the agent received). Renders in the SAME visual language as
     the cron notice (CronNotice.vue): one small faint provenance line ABOVE
     the content (status icon + title + source id, e.g. "后台任务完成 ·
     bash-lo9yv9ch", mirroring the cron head's "title · schedule"), then the
     notification's own text in a neutral grey rounded block — title, body,
     the output-file row (path + size + copy-path button) and/or the
     output-preview block (clamped monospace tail of the task output), with
     the raw-payload <details> disclosure (type / source / severity + the
     verbatim XML in a height-capped monospace scroller) fused INTO the block
     as its last section; only the event time sits underneath. The label, the
     block and the meta all snap to the RIGHT edge of a right-aligned,
     max-width-capped column, exactly like the cron notice / user bubble
     rhythm. ONE render
     block feeds `items`; every notification renders as its own notice, in
     order — consecutive ones stack instead of collapsing into a group card. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { TaskNotification } from '@moonshot-ai/app-core/client/types';
import {
  notificationStatus,
  notificationVariant,
  type NotificationStatus,
  type NotificationVariant,
} from '@moonshot-ai/app-core/client';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import MessageTime from './MessageTime.vue';

defineProps<{ items: TaskNotification[] }>();

const { t } = useI18n();

const STATUS_ICON: Record<NotificationStatus, string> = {
  completed: 'check',
  failed: 'alert-triangle',
  timed_out: 'clock',
  killed: 'stop',
  lost: 'alert-triangle',
  info: 'info',
};

function keyOf(n: TaskNotification, index: number): string {
  // The index must participate: a duplicated id (streamed + persisted copy of
  // the same notification, or a repeated id inside a merged payload) would
  // otherwise share one Vue key.
  return n.id !== '' ? `${n.id}#${index}` : `ntf-${index}`;
}

function iconOf(n: TaskNotification): string {
  const status = notificationStatus(n);
  if (status === 'info' && n.sourceKind === 'subagent') return 'robot';
  return STATUS_ICON[status];
}

function kindLabel(n: TaskNotification): string {
  return n.sourceKind === 'subagent'
    ? t('conversation.notification.kindSubagent')
    : t('conversation.notification.kindTask');
}

function titleOf(n: TaskNotification): string {
  return t(`conversation.notification.title.${notificationStatus(n)}`, { kind: kindLabel(n) });
}

function variantOf(n: TaskNotification): NotificationVariant {
  return notificationVariant(n);
}

// The id in the head line (the cron head's schedule slot): for a subagent the
// actionable id is agent_id (what Agent(resume=…) takes), otherwise the task
// id carried by source_id.
function sourceLabel(n: TaskNotification): string {
  if (n.sourceKind === 'subagent' && n.agentId !== undefined && n.agentId !== '') return n.agentId;
  return n.sourceId;
}

function headLabel(n: TaskNotification): string {
  const source = sourceLabel(n);
  return source === '' ? titleOf(n) : `${titleOf(n)} · ${source}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Caption above the output preview: the truncation state (the block's own
// explanation line, rebuilt from the parsed attrs so it translates) plus the
// preview/full sizes when known.
function previewCaption(n: TaskNotification): string {
  const p = n.outputPreview;
  if (!p) return '';
  const parts: string[] = [];
  if (p.truncated === true) parts.push(t('conversation.notification.outputTruncated'));
  if (p.bytes !== undefined) {
    parts.push(
      p.totalBytes !== undefined && p.totalBytes !== p.bytes
        ? `${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}`
        : formatBytes(p.bytes),
    );
  }
  return parts.join(' · ');
}

function hasPreview(n: TaskNotification): boolean {
  return n.outputPreview !== undefined && (n.outputPreview.text !== '' || previewCaption(n) !== '');
}

const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copyPath(path: string, key: string): Promise<void> {
  const ok = await copyTextToClipboard(path);
  if (!ok) return;
  copiedKey.value = key;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedTimer = null;
    copiedKey.value = null;
  }, 1200);
}
</script>

<template>
  <div class="ntf-list">
    <div
      v-for="(n, i) in items"
      :key="keyOf(n, i)"
      class="ntn"
      :class="variantOf(n)"
      role="status"
    >
      <div class="ntn-head">
        <Icon :name="iconOf(n)" size="sm" class="ntn-ico" aria-hidden="true" />
        <span class="ntn-head-text">{{ headLabel(n) }}</span>
      </div>
      <div class="ntn-bubble">
        <div v-if="n.title" class="ntn-line">{{ n.title }}</div>
        <div v-if="n.body" class="ntn-line ntn-body">{{ n.body }}</div>
        <div v-if="n.outputFile" class="ntn-line ntn-out">
          <Icon class="ntn-out-ic" name="file-text" size="sm" aria-hidden="true" />
          <span class="ntn-out-path" :title="n.outputFile.path">{{ n.outputFile.path }}</span>
          <span v-if="n.outputFile.bytes !== undefined" class="ntn-out-size">{{
            formatBytes(n.outputFile.bytes)
          }}</span>
          <button
            class="ntn-out-copy"
            type="button"
            @click="copyPath(n.outputFile.path, keyOf(n, i))"
          >
            {{
              copiedKey === keyOf(n, i)
                ? t('conversation.notification.copied')
                : t('conversation.notification.copyPath')
            }}
          </button>
        </div>
        <div v-if="hasPreview(n)" class="ntn-line ntn-preview">
          <div v-if="previewCaption(n) !== ''" class="ntn-preview-cap">{{ previewCaption(n) }}</div>
          <pre v-if="n.outputPreview?.text" class="ntn-preview-text">{{ n.outputPreview.text }}</pre>
        </div>
        <details class="ntn-line ntn-raw">
          <summary>
            <Icon class="ntn-raw-car" name="chevron-right" size="sm" aria-hidden="true" />
            <span>{{ t('conversation.notification.rawPayload') }}</span>
          </summary>
          <div class="ntn-raw-in">
            <div class="ntn-raw-fields">
              <span class="k">{{ t('conversation.notification.fields.type') }}</span>
              <span class="v">{{ n.type }}</span>
              <span class="k">{{ t('conversation.notification.fields.source') }}</span>
              <span class="v">{{ n.sourceKind }} · {{ n.sourceId }}</span>
              <span class="k">{{ t('conversation.notification.fields.severity') }}</span>
              <span class="v">{{ n.severity || '—' }}</span>
            </div>
            <pre class="ntn-raw-pre">{{ n.raw }}</pre>
          </div>
        </details>
      </div>
      <div class="ntn-meta">
        <MessageTime v-if="n.createdAt" :time="n.createdAt" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Consecutive notifications stack as independent notices (the cron notice's
   rhythm), never as a collapsed group card. The column right-aligns its
   notices, matching the cron notice / user bubble side of the stream. */
.ntf-list {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-3);
  margin: var(--space-2) 0;
}

/* Right-aligned column capped like the user bubble (CronNotice's .cn): the
   label, the block and the meta all snap to its right edge. margin-left:auto
   keeps it on the right even inside a non-flex block container. */
.ntn {
  margin-left: auto;
  max-width: var(--p-bubble-max);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* Provenance line above the block — the cron notice's head language: small
   and faint so it reads as context for the block, not as message content.
   Only the icon carries the status colour. */
.ntn-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.ntn-ico {
  flex: none;
}
.ntn.ok .ntn-ico { color: var(--color-success); }
.ntn.err .ntn-ico { color: var(--color-danger); }
.ntn.warn .ntn-ico { color: var(--color-warning); }

/* The notification's own text, in the same neutral grey rounded block the
   cron notice uses for the fired prompt (BubbleGray fill, uniform radius, no
   border, no shadow). Title and body are shown in full, wrapping across
   lines — no truncation. The block always renders: even a content-less
   notification still carries the raw-payload disclosure as its last line. */
.ntn-bubble {
  box-sizing: border-box;
  max-width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-user-bubble-bg);
  border-radius: var(--radius-lg);
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ntn-line + .ntn-line {
  margin-top: var(--space-1);
}

/* Output-file row: a raised strip inside the grey bubble carrying the path
   (mono, ellipsized), the formatted size and the copy-path button. */
.ntn-out {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--color-surface-raised);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-2);
  box-shadow: var(--shadow-xs);
  white-space: normal;
}
.ntn-out-ic {
  color: var(--color-text-faint);
  flex: none;
}
.ntn-out-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.ntn-out-size {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.ntn-out-copy {
  display: inline-flex;
  align-items: center;
  height: var(--space-6);
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  border: 0.5px solid var(--color-line-strong);
  background: var(--color-surface-raised);
  flex: none;
  transition: color var(--duration-fast) var(--ease-out);
}
.ntn-out-copy:hover {
  color: var(--color-text);
}

/* Output preview: the buffered task output in mono, clamped to a few lines —
   the line-clamp ellipsis marks the on-screen cut, and the caption above
   carries the payload's own truncated flag + sizes. */
.ntn-preview-cap {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  margin-bottom: var(--space-05);
}
.ntn-preview-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 8;
  overflow: hidden;
}

/* Meta under the block: just the event time (same spot as the cron notice's
   fire time), small and faint. */
.ntn-meta {
  margin-top: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}

/* Raw-payload disclosure: the bubble's last section, fused with the content
   above it — a faint small summary line, then the type / source / severity
   fields and the verbatim XML in a height-capped monospace scroller (the
   output-preview block's mono language). */
.ntn-raw {
  max-width: 100%;
}
.ntn-raw summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  user-select: none;
}
.ntn-raw summary::-webkit-details-marker {
  display: none;
}
.ntn-raw summary:hover {
  color: var(--color-text);
}
.ntn-raw-car {
  transition: transform var(--duration-base) var(--ease-out);
}
.ntn-raw[open] .ntn-raw-car {
  transform: rotate(90deg);
}
.ntn-raw-in {
  margin-top: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ntn-raw-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
}
.ntn-raw-fields .k {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.ntn-raw-fields .v {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ntn-raw-pre {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-raised);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-xs);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  white-space: pre;
  overflow: auto;
  max-width: 100%;
  /* Height-capped scroller: ~13 lines of the mono payload (the user-text
     clamp's `calc(N * 1lh)` idiom, so the cap follows the content font). */
  max-height: calc(13 * 1lh);
}
</style>
