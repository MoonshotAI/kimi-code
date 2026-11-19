<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatStepMs } from '@moonshot-ai/app-core/lib';
import { Badge, SegmentedControl } from '@moonshot-ai/app-ui';
import { formatTraceTime, type HttpExchange } from '@moonshot-ai/app-client/trace';
import InspectorJson from './InspectorJson.vue';

const props = defineProps<{
  exchange: HttpExchange;
  now: number;
  tab: string;
}>();

const emit = defineEmits<{ 'update:tab': [tab: string] }>();

const { t } = useI18n();

const tabOptions = computed(() => [
  { value: 'headers', label: t('panel.inspector.http.headers') },
  { value: 'payload', label: t('panel.inspector.http.payload') },
  { value: 'response', label: t('panel.inspector.http.response') },
  { value: 'timing', label: t('panel.inspector.http.timing') },
]);

const pending = computed(() => props.exchange.endedAt === undefined);
const codeFailed = computed(() => props.exchange.code !== undefined && props.exchange.code !== 0);

const statusLabel = computed(() => {
  const { status, statusText } = props.exchange;
  if (pending.value) return t('panel.inspector.http.pending');
  if (props.exchange.cancelled) return t('panel.inspector.http.cancelled');
  if (status === undefined) return t('panel.inspector.http.failed');
  return statusText ? `${status} ${statusText}` : String(status);
});

const statusVariant = computed(() => {
  const { status, failure } = props.exchange;
  if (pending.value || props.exchange.cancelled) return 'neutral';
  if (failure !== undefined || status === undefined || status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  return 'success';
});

const queueMs = computed(() => props.exchange.queueMs ?? 0);
const requestMs = computed(() => {
  const { durationMs, sentAt } = props.exchange;
  if (durationMs !== undefined) return durationMs;
  return sentAt === undefined ? 0 : Math.max(0, props.now - sentAt);
});
const totalMs = computed(() => queueMs.value + requestMs.value);

const durationLabel = computed(() => {
  if (pending.value) return t('panel.inspector.http.elapsed', { elapsed: formatStepMs(requestMs.value) });
  const total = formatStepMs(totalMs.value);
  if (queueMs.value === 0) return total;
  return t('panel.inspector.http.durationQueued', { total, queue: formatStepMs(queueMs.value) });
});

const parsedUrl = computed(() => {
  const { url } = props.exchange;
  if (url === undefined) return undefined;
  try {
    return new URL(url, window.location.href);
  } catch {
    return undefined;
  }
});
const queryParams = computed(() => (parsedUrl.value === undefined ? [] : [...parsedUrl.value.searchParams]));
const crossOrigin = computed(() => parsedUrl.value !== undefined && parsedUrl.value.origin !== window.location.origin);

function sortedHeaders(headers: Record<string, string> | undefined): [string, string][] {
  return Object.entries(headers ?? {}).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
const requestHeaders = computed(() => sortedHeaders(props.exchange.requestHeaders));
const responseHeaders = computed(() => sortedHeaders(props.exchange.responseHeaders));

function toJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
const requestBody = computed(() => toJson(props.exchange.requestBody));
const responseBody = computed(() => toJson(props.exchange.responseBody));

const timestamps = computed(() => {
  const { sentAt, endedAt, queueMs: queued } = props.exchange;
  const rows: { key: string; label: string; ts: number }[] = [];
  if (sentAt !== undefined && queued !== undefined) {
    rows.push({ key: 'queued', label: t('panel.inspector.http.queuedAt'), ts: sentAt - queued });
  }
  if (sentAt !== undefined) rows.push({ key: 'sent', label: t('panel.inspector.http.sentAt'), ts: sentAt });
  if (endedAt !== undefined) rows.push({ key: 'ended', label: t('panel.inspector.http.endedAt'), ts: endedAt });
  return rows;
});

const phases = computed(() => {
  const scale = Math.max(totalMs.value, 1);
  const rows: { key: string; label: string; startMs: number; ms: number }[] = [];
  if (props.exchange.queueMs !== undefined) {
    rows.push({ key: 'queue', label: t('panel.inspector.http.queue'), startMs: 0, ms: queueMs.value });
  }
  rows.push({ key: 'request', label: t('panel.inspector.http.request'), startMs: queueMs.value, ms: requestMs.value });
  return rows.map((row) => ({
    ...row,
    style: { left: `${(row.startMs / scale) * 100}%`, width: `${(row.ms / scale) * 100}%` },
  }));
});
</script>

<template>
  <div class="http">
    <div class="http-summary">
      <Badge :variant="statusVariant" size="sm" dot>{{ statusLabel }}</Badge>
      <Badge v-if="codeFailed" variant="danger" size="sm">
        {{ t('panel.inspector.http.codeBadge', { code: exchange.code }) }}
      </Badge>
      <span class="http-duration">{{ durationLabel }}</span>
      <SegmentedControl
        class="http-tabs"
        size="xs"
        :model-value="tab"
        :options="tabOptions"
        @update:model-value="emit('update:tab', $event)"
      />
    </div>

    <div class="http-body">
      <template v-if="tab === 'payload'">
        <section v-if="queryParams.length > 0" class="http-section">
          <h4 class="http-title">
            {{ t('panel.inspector.http.query') }}
            <span class="http-count">{{ queryParams.length }}</span>
          </h4>
          <dl class="http-kv">
            <template v-for="([name, value], index) in queryParams" :key="index">
              <dt>{{ name }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
        </section>
        <section v-if="requestBody !== undefined" class="http-section">
          <h4 class="http-title">{{ t('panel.inspector.http.requestBody') }}</h4>
          <div class="http-code"><InspectorJson :json="requestBody" /></div>
        </section>
        <p v-if="queryParams.length === 0 && requestBody === undefined" class="http-empty">
          {{ t('panel.inspector.http.noPayload') }}
        </p>
      </template>

      <template v-else-if="tab === 'response'">
        <p v-if="pending" class="http-empty">{{ t('panel.inspector.http.waiting') }}</p>
        <p v-else-if="exchange.cancelled" class="http-empty">{{ t('panel.inspector.http.cancelledBody') }}</p>
        <template v-else-if="exchange.failure">
          <section class="http-section">
            <h4 class="http-title">{{ t('panel.inspector.http.error') }}</h4>
            <p class="http-error">{{ exchange.failure.error }}</p>
          </section>
          <section v-if="exchange.failure.bodyPreview" class="http-section">
            <h4 class="http-title">{{ t('panel.inspector.http.bodyPreview') }}</h4>
            <pre class="http-preview">{{ exchange.failure.bodyPreview }}</pre>
          </section>
        </template>
        <div v-else-if="responseBody !== undefined" class="http-code"><InspectorJson :json="responseBody" /></div>
        <p v-else class="http-empty">{{ t('panel.inspector.http.noResponseBody') }}</p>
      </template>

      <template v-else-if="tab === 'timing'">
        <dl v-if="timestamps.length > 0" class="http-kv">
          <template v-for="row in timestamps" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd>{{ formatTraceTime(row.ts) }}</dd>
          </template>
        </dl>
        <div class="http-waterfall">
          <template v-for="row in phases" :key="row.key">
            <span class="http-phase">{{ row.label }}</span>
            <span class="http-track"><span class="http-segment" :class="row.key" :style="row.style" /></span>
            <span class="http-ms">{{ formatStepMs(row.ms) }}</span>
          </template>
          <span class="http-phase http-total">{{ t('panel.inspector.http.total') }}</span>
          <span />
          <span class="http-ms http-total">{{ formatStepMs(totalMs) }}</span>
        </div>
        <p class="http-note">{{ t('panel.inspector.http.timingHint') }}</p>
      </template>

      <template v-else>
        <section class="http-section">
          <h4 class="http-title">{{ t('panel.inspector.http.general') }}</h4>
          <dl class="http-kv">
            <dt>{{ t('panel.inspector.http.url') }}</dt>
            <dd>{{ exchange.url ?? exchange.path }}</dd>
            <dt>{{ t('panel.inspector.http.method') }}</dt>
            <dd>{{ exchange.method }}</dd>
            <dt>{{ t('panel.inspector.http.status') }}</dt>
            <dd :class="{ danger: statusVariant === 'danger' }">{{ statusLabel }}</dd>
            <template v-if="exchange.code !== undefined">
              <dt>{{ t('panel.inspector.http.code') }}</dt>
              <dd :class="{ danger: codeFailed }">{{ exchange.msg ? `${exchange.code} ${exchange.msg}` : exchange.code }}</dd>
            </template>
            <template v-if="exchange.failure">
              <dt>{{ t('panel.inspector.http.failedPhase') }}</dt>
              <dd class="danger">{{ exchange.failure.phase }}</dd>
            </template>
            <dt>{{ t('panel.inspector.http.requestId') }}</dt>
            <dd>{{ exchange.requestId }}</dd>
          </dl>
        </section>
        <section v-if="!pending" class="http-section">
          <h4 class="http-title">
            {{ t('panel.inspector.http.responseHeaders') }}
            <span class="http-count">{{ responseHeaders.length }}</span>
          </h4>
          <p v-if="crossOrigin" class="http-note">{{ t('panel.inspector.http.crossOrigin') }}</p>
          <dl v-if="responseHeaders.length > 0" class="http-kv">
            <template v-for="[name, value] in responseHeaders" :key="name">
              <dt>{{ name }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
        </section>
        <section class="http-section">
          <h4 class="http-title">
            {{ t('panel.inspector.http.requestHeaders') }}
            <span class="http-count">{{ requestHeaders.length }}</span>
          </h4>
          <dl v-if="requestHeaders.length > 0" class="http-kv">
            <template v-for="[name, value] in requestHeaders" :key="name">
              <dt>{{ name }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.http {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.http-summary {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.http-duration {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.http-tabs {
  margin-left: auto;
}
.http-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3) var(--space-3);
}
.http-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.http-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.http-count {
  color: var(--color-text-faint);
  font-weight: var(--weight-regular);
  font-variant-numeric: tabular-nums;
}
.http-kv {
  display: grid;
  grid-template-columns: fit-content(40%) minmax(0, 1fr);
  gap: var(--space-05) var(--space-3);
  margin: 0;
}
.http-kv dt {
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}
.http-kv dd {
  margin: 0;
  font-family: var(--font-mono);
  color: var(--color-text);
  overflow-wrap: anywhere;
  user-select: text;
}
.http-kv dd.danger {
  color: var(--color-danger);
}
.http-note {
  margin: 0;
  color: var(--color-text-faint);
}
.http-empty {
  margin: 0;
  padding: var(--space-4) 0;
  text-align: center;
  color: var(--color-text-faint);
}
.http-code {
  overflow-x: auto;
  border-radius: var(--radius-sm);
  background: var(--color-well);
  user-select: text;
}
.http-error,
.http-preview {
  margin: 0;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
  user-select: text;
}
.http-error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.http-preview {
  background: var(--color-well);
  color: var(--color-text-muted);
  white-space: pre-wrap;
}
.http-waterfall {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: center;
  gap: var(--space-1-5) var(--space-2);
}
.http-phase {
  color: var(--color-text-muted);
}
.http-track {
  position: relative;
  height: 8px;
  border-radius: var(--radius-xs);
  background: var(--color-hover);
}
.http-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  border-radius: var(--radius-xs);
}
.http-segment.queue {
  background: var(--color-text-faint);
}
.http-segment.request {
  background: var(--color-accent);
}
.http-ms {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
.http-total {
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
</style>
