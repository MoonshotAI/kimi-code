<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { TaskNotification } from '@moonshot-ai/app-core/client/types';
import {
  cleanNotificationRest,
  compactNotificationOutputPath,
  formatNotificationDuration,
  isStockNotificationTitle,
  notificationStatus,
  notificationVariant,
  splitNotificationWallTime,
  stockNotificationDisplay,
  type NotificationVariant,
} from '@moonshot-ai/app-core/client';
import MessageTime from './MessageTime.vue';
import QuestionNotificationCard from './QuestionNotificationCard.vue';
import ToolDisclosure from './tool-calls/ToolDisclosure.vue';
import ToolPanel from './tool-calls/ToolPanel.vue';
import OutputPanel from './tool-calls/OutputPanel.vue';
import { useHistoryState } from './historyState';

defineProps<{ items: TaskNotification[] }>();

const { t, locale } = useI18n();
const openKeys = useHistoryState('notification:open', new Set<string>());

function keyOf(n: TaskNotification, index: number): string {
  return n.id !== '' ? `${n.id}#${index}` : `ntf-${index}`;
}

function isOpen(n: TaskNotification, index: number): boolean {
  return openKeys.value.has(keyOf(n, index));
}

function toggleOpen(n: TaskNotification, index: number): void {
  const key = keyOf(n, index);
  if (openKeys.value.has(key)) openKeys.value.delete(key);
  else openKeys.value.add(key);
}

function isSubagentNotification(n: TaskNotification): boolean {
  return n.sourceKind === 'subagent' || (n.agentId !== undefined && n.agentId !== '');
}

function isQuestionReceipt(n: TaskNotification): boolean {
  return (
    n.questionAnswer !== undefined ||
    (n.sourceId.startsWith('question-') && notificationStatus(n) === 'killed')
  );
}

function leadingIcon(n: TaskNotification): string {
  return isSubagentNotification(n) ? 'robot' : 'terminal';
}

function senderLabel(n: TaskNotification): string {
  return isSubagentNotification(n)
    ? t('conversation.notification.sentBy.subagent')
    : t('conversation.notification.sentBy.task');
}

function senderShortLabel(n: TaskNotification): string {
  return isSubagentNotification(n)
    ? t('conversation.notification.senderShort.subagent')
    : t('conversation.notification.senderShort.task');
}

function variantOf(n: TaskNotification): NotificationVariant {
  return notificationVariant(n);
}

function isWarningNotice(n: TaskNotification): boolean {
  return variantOf(n) === 'warn' && notificationStatus(n) !== 'killed';
}

function toolStatusOf(n: TaskNotification): 'ok' | 'error' | 'cancelled' {
  const status = notificationStatus(n);
  if (status === 'killed') return 'cancelled';
  if (variantOf(n) === 'err') return 'error';
  return 'ok';
}

function statusLabel(n: TaskNotification): string {
  const stock = stockNotificationDisplay(n);
  if (stock?.userStopped === true) return t('conversation.notification.userStopped');
  return t(`conversation.notification.statusTitle.${notificationStatus(n)}`);
}

function wallTimeMsOf(n: TaskNotification): number | undefined {
  const stock = stockNotificationDisplay(n);
  if (stock?.wallTimeMs !== undefined) return stock.wallTimeMs;
  return splitNotificationWallTime(n.body).wallTimeMs;
}

function durationText(n: TaskNotification): string {
  return formatNotificationDuration(wallTimeMsOf(n), locale.value);
}

function customTitle(n: TaskNotification): string {
  return isStockNotificationTitle(n.title) ? '' : n.title.trim();
}

function subjectText(n: TaskNotification): string {
  const stock = stockNotificationDisplay(n);
  if (stock !== undefined) return stock.description;
  const title = customTitle(n);
  const { content } = splitNotificationWallTime(n.body);
  const firstLine = (content.split(/\r?\n/)[0] ?? '').trim();
  if (title !== '' && firstLine !== '' && title !== firstLine) return `${title} · ${firstLine}`;
  return title || firstLine;
}

function fullDescriptionText(n: TaskNotification): string {
  const stock = stockNotificationDisplay(n);
  if (stock !== undefined) {
    const rest = cleanNotificationRest(stock.rest);
    return [stock.description, rest].filter((part) => part !== undefined && part !== '').join('\n');
  }
  const title = customTitle(n);
  const { content } = splitNotificationWallTime(n.body);
  const trimmed = content.trim();
  if (title !== '' && trimmed !== '' && title !== trimmed) return `${title}\n${trimmed}`;
  return title || trimmed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function previewCaption(n: TaskNotification): string {
  const p = n.outputPreview;
  if (!p) return '';
  const parts: string[] = [];
  if (p.truncated === true) parts.push(t('conversation.notification.outputTruncated'));
  if (p.bytes !== undefined) parts.push(formatBytes(p.bytes));
  return parts.join(' · ');
}

function hasPreview(n: TaskNotification): boolean {
  return n.outputPreview !== undefined && (n.outputPreview.text !== '' || previewCaption(n) !== '');
}

function previewLines(n: TaskNotification): string[] {
  const text = n.outputPreview?.text ?? '';
  return text === '' ? [] : text.split(/\r?\n/);
}

interface DetailRow {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
}

function detailRows(n: TaskNotification): DetailRow[] {
  const rows: DetailRow[] = [];
  const stock = stockNotificationDisplay(n);
  const fullDesc = fullDescriptionText(n);
  if (
    fullDesc !== '' &&
    (stock === undefined || fullDesc.includes('\n') || fullDesc.length > 48 || (!n.outputFile && !hasPreview(n)))
  ) {
    rows.push({ key: 'description', label: t('tools.waitfor.field.description'), value: fullDesc });
  }
  if (stock?.reason !== undefined && stock.reason !== '') {
    rows.push({ key: 'reason', label: t('tools.bgTask.field.reason'), value: stock.reason });
  }
  if (n.sourceId !== '') {
    rows.push({ key: 'sourceId', label: t('conversation.notification.taskIdLabel'), value: n.sourceId, mono: true });
  }
  const wallMs = wallTimeMsOf(n);
  if (wallMs !== undefined) {
    rows.push({
      key: 'elapsed',
      label: t('tools.browser.detail.facts.elapsed'),
      value: `${(wallMs / 1000).toFixed(2)}s`,
      mono: true,
    });
  }
  if (n.createdAt) {
    rows.push({
      key: 'createdAt',
      label: t('conversation.notification.timeLabel'),
      value: n.createdAt,
      mono: true,
    });
  }
  if (n.outputFile?.path) {
    const size = n.outputFile.bytes !== undefined ? ` (${formatBytes(n.outputFile.bytes)})` : '';
    rows.push({
      key: 'outputPath',
      label: t('tools.bgTask.field.output_path'),
      value: `${n.outputFile.path}${size}`,
      mono: true,
    });
  }
  return rows;
}

function detailPanelTitle(n: TaskNotification): string {
  return n.outputFile ? t('conversation.notification.outputFileLabel') : senderShortLabel(n);
}

function detailPanelMeta(n: TaskNotification): string {
  if (!n.outputFile) return '';
  const parts = [compactNotificationOutputPath(n.outputFile.path)];
  if (n.outputFile.bytes !== undefined) parts.push(formatBytes(n.outputFile.bytes));
  return parts.join(' · ');
}

function canExpand(n: TaskNotification): boolean {
  return detailRows(n).length > 0 || Boolean(n.outputFile) || hasPreview(n);
}
</script>

<template>
  <div class="ntf-list">
    <div
      v-for="(n, i) in items"
      :key="keyOf(n, i)"
      class="ntn"
      :class="[variantOf(n), { question: isQuestionReceipt(n), open: !isQuestionReceipt(n) && isOpen(n, i) }]"
      role="status"
    >
      <QuestionNotificationCard
        v-if="isQuestionReceipt(n)"
        :notification="n"
        :detail-key="keyOf(n, i)"
      />
      <template v-else>
        <span class="ntn-sr-only">{{ senderLabel(n) }}</span>
        <ToolDisclosure
          :status="toolStatusOf(n)"
          :open="isOpen(n, i)"
          :expandable="canExpand(n)"
          @toggle="toggleOpen(n, i)"
        >
          <template #leading>
            <Icon :name="leadingIcon(n)" size="sm" />
          </template>
          <span class="tl-name">{{ senderShortLabel(n) }}</span>
          <span v-if="subjectText(n)" class="tl-dim">{{ subjectText(n) }}</span>
          <span class="tl-faint" :class="{ 'ntn-warn-label': isWarningNotice(n) }">{{ statusLabel(n) }}</span>
          <template #trailing>
            <span v-if="durationText(n)" class="tl-chip">{{ durationText(n) }}</span>
            <span v-if="isWarningNotice(n)" class="ntn-warn-ico" aria-hidden="true">
              <Icon name="alert-triangle" size="sm" />
            </span>
          </template>
          <template #body>
            <div class="ntn-panels">
              <ToolPanel
                v-if="detailRows(n).length > 0 || n.outputFile"
                flush
                compact
                :title="detailPanelTitle(n)"
                :meta="detailPanelMeta(n)"
                :copy-text="n.outputFile?.path ?? ''"
              >
                <dl v-if="detailRows(n).length > 0" class="ntn-dl">
                  <template v-for="row in detailRows(n)" :key="row.key">
                    <dt>{{ row.label }}</dt>
                    <dd :class="{ mono: row.mono }">
                      <MessageTime v-if="row.key === 'createdAt'" :time="row.value" />
                      <template v-else>{{ row.value }}</template>
                    </dd>
                  </template>
                </dl>
              </ToolPanel>
              <ToolPanel
                v-if="hasPreview(n)"
                flush
                compact
                :title="t('tasks.fieldOutput')"
                :meta="previewCaption(n)"
                :copy-text="n.outputPreview?.text ?? ''"
              >
                <OutputPanel
                  :lines="previewLines(n)"
                  :empty-text="t('tools.output.empty')"
                />
              </ToolPanel>
            </div>
          </template>
        </ToolDisclosure>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ntf-list {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--chat-strip-tight, var(--space-1));
  margin: 0;
}

.ntn {
  width: 100%;
  min-width: 0;
}

.ntn.open + .ntn {
  margin-top: var(--space-1);
}

.ntn-warn-label,
.ntn-warn-ico {
  color: var(--color-warning);
}

.ntn-warn-ico {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.ntn-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.ntn-panels {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.ntn-panels :deep(.op) {
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--code-font-size);
}

.ntn-dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px var(--space-3);
  margin: 0;
  padding: 2px var(--space-3) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: 18px;
}

.ntn-dl dt {
  color: var(--color-text-faint);
}

.ntn-dl dd {
  margin: 0;
  min-width: 0;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ntn-dl dd.mono {
  font-family: var(--font-mono);
}

.ntn-dl :deep(.msg-time) {
  min-height: 0;
  padding: 0;
  color: inherit;
  font-weight: inherit;
  line-height: inherit;
  opacity: 1;
}
</style>
