<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { OpenMediaRequest, ToolCall } from '@moonshot-ai/app-core/client/types';
import type { BrowserFact, BrowserSection, BrowserToolView } from '../browserToolView';
import ToolPanel from '../ToolPanel.vue';
import OutputPanel from '../OutputPanel.vue';
import BrowserFacts from './BrowserFacts.vue';
import BrowserFold from './BrowserFold.vue';
import BrowserShot from './BrowserShot.vue';
import BrowserReceiptView from './BrowserReceiptView.vue';
import BrowserTable, { type BrowserTableCell } from './BrowserTable.vue';
import BrowserValueView from './BrowserValueView.vue';

type Section<K extends BrowserSection['kind']> = Extract<BrowserSection, { kind: K }>;

const props = defineProps<{ tool: ToolCall; view: BrowserToolView | undefined; running: boolean; sessionId?: string }>();
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();
const { t, te } = useI18n();

function pick<K extends BrowserSection['kind']>(kind: K): Section<K> | undefined {
  return props.view?.sections.find((section): section is Section<K> => section.kind === kind);
}

const error = computed(() => pick('error'));
const page = computed(() => pick('page'));

const errorText = computed(() => {
  const key = `tools.browser.detail.errors.${error.value?.code ?? ''}`;
  return te(key) ? t(key) : '';
});

const summary = computed<BrowserFact[]>(() => {
  const facts = [...(pick('request')?.facts ?? []), ...(pick('result')?.facts ?? [])];
  const current = page.value;
  if (current === undefined) return facts;
  if (current.title && !current.changes.some((change) => change.key === 'pageTitle')) {
    facts.push({ key: 'pageTitle', value: { type: 'text', text: current.title } });
  }
  if (current.url) facts.push({ key: 'pageUrl', value: { type: 'url', url: current.url } });
  return facts;
});

const panels = computed(() => (props.view?.sections ?? []).filter((section) =>
  section.kind !== 'error' && section.kind !== 'request' && section.kind !== 'result' && section.kind !== 'page'));

const text = (value: string | undefined): BrowserTableCell => value === undefined ? null : { type: 'text', text: value };
const code = (value: string | undefined): BrowserTableCell => value === undefined ? null : { type: 'code', text: value };
const flag = (value: boolean | undefined): BrowserTableCell => value === undefined ? null : { type: 'bool', value };

function elementRows(section: Section<'elements'>): BrowserTableCell[][] {
  return section.rows.map((row) => [code(row.ref), code(row.role), text(row.name), text(row.text), text(row.value), { type: 'states', items: row.states }]);
}

function candidateRows(section: Section<'candidates'>): BrowserTableCell[][] {
  return section.rows.map((row) => [
    text(t(`tools.browser.detail.relation.${row.relation}`)),
    code(row.ref),
    code(row.role),
    text(row.name),
    code(row.tagName),
    code(row.id),
    row.classes.length > 0 ? { type: 'code', text: row.classes.join(' ') } : null,
    code(row.evidence),
    flag(row.clickable),
    flag(row.disabled),
    row.bounds === undefined ? null : { type: 'region', ...row.bounds },
  ]);
}

function tabRows(section: Section<'tabs'>): BrowserTableCell[][] {
  return section.rows.map((row) => [
    code(row.tabId),
    text(row.title),
    row.url === undefined ? null : { type: 'url', url: row.url },
    flag(row.controlled),
    flag(row.visible),
    flag(row.loading),
  ]);
}

const restGroups = computed(() => (['args', 'result'] as const)
  .map((source) => ({ source, entries: (props.view?.rest ?? []).filter((entry) => entry.source === source) }))
  .filter((group) => group.entries.length > 0));

function restValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

const outputText = computed(() => props.tool.output?.join('\n') ?? '');
const emptyOutput = computed(() => t(props.running ? 'tools.output.waiting' : 'tools.output.empty'));
</script>

<template>
  <div class="btd">
    <template v-if="view">
      <ToolPanel v-if="error || summary.length > 0 || page">
        <div class="btd-stack">
          <div v-if="error" class="btd-error">
            <div class="btd-error-head">
              <span class="btd-error-code">{{ error.code }}</span>
              <span v-if="errorText">{{ errorText }}</span>
            </div>
            <div v-if="error.message" class="btd-error-message">{{ error.message }}</div>
            <BrowserFacts v-if="error.facts.length > 0" :facts="error.facts" layout="chips" />
          </div>
          <BrowserFacts v-if="summary.length > 0" :facts="summary" />
          <BrowserFacts v-if="page && page.facts.length > 0" :facts="page.facts" layout="chips" />
          <div v-if="page?.compared" class="btd-changes">
            <div class="btd-changes-title">{{ t(page.changes.length > 0 ? 'tools.browser.detail.changes' : 'tools.browser.detail.unchanged') }}</div>
            <dl v-if="page.changes.length > 0" class="btd-change-rows">
              <template v-for="change in page.changes" :key="change.key">
                <dt>{{ t(`tools.browser.detail.facts.${change.key}`) }}</dt>
                <dd>
                  <span class="btd-before"><BrowserValueView :value="change.before" /></span>
                  <span class="btd-after"><Icon class="btd-arrow" name="arrow-right" size="sm" /><BrowserValueView :value="change.after" /></span>
                </dd>
              </template>
            </dl>
            <div class="btd-changes-note">{{ t('tools.browser.detail.unchangedNote') }}</div>
          </div>
        </div>
      </ToolPanel>

      <template v-for="(section, index) in panels" :key="`${section.kind}-${index}`">
        <ToolPanel v-if="section.kind === 'receipt'" :title="t('tools.browser.detail.titles.receipt')" :meta="section.id">
          <BrowserReceiptView :session-id="sessionId" :receipt-id="section.id" @open-media="emit('openMedia', $event)" />
        </ToolPanel>

        <ToolPanel
          v-else-if="section.kind === 'shot'"
          :title="t(section.origin === 'result' ? 'tools.browser.detail.titles.shot' : 'tools.browser.detail.titles.location')"
          :meta="`${section.width} × ${section.height}`"
        >
          <div class="btd-stack">
            <BrowserShot
              v-if="section.media"
              :media="section.media"
              :width="section.width"
              :height="section.height"
              :marks="section.marks"
              @open-media="emit('openMedia', $event)"
            />
            <BrowserFacts v-if="section.facts.length > 0" :facts="section.facts" layout="chips" />
          </div>
        </ToolPanel>

        <ToolPanel
          v-else-if="section.kind === 'elements'"
          :title="t('tools.browser.detail.titles.elements')"
          :meta="t('tools.browser.detail.items', { count: section.rows.length })"
          scroll
        >
          <div class="btd-stack">
            <BrowserFacts v-if="section.facts.length > 0" :facts="section.facts" layout="chips" />
            <BrowserTable :columns="['ref', 'role', 'name', 'text', 'value', 'state']" :rows="elementRows(section)" />
          </div>
        </ToolPanel>

        <ToolPanel
          v-else-if="section.kind === 'text'"
          :title="t('tools.browser.detail.titles.text')"
          :meta="t('tools.browser.detail.blocks', { count: section.blocks.length })"
          scroll
        >
          <div class="btd-stack">
            <BrowserFacts v-if="section.facts.length > 0" :facts="section.facts" layout="chips" />
            <div class="btd-blocks">
              <template v-for="(block, blockIndex) in section.blocks" :key="blockIndex">
                <span class="btd-block-id">{{ block.id }}</span>
                <span class="btd-block-kind">{{ block.kind }}</span>
                <span class="btd-block-text" :class="`is-${block.kind}`">{{ block.text }}<span
                  v-if="block.part !== undefined && block.part !== 1"
                  class="btd-block-note"
                >{{ t('tools.browser.detail.blockPart', { part: block.part }) }}</span><span
                  v-if="block.continued"
                  class="btd-block-note"
                >{{ t('tools.browser.detail.blockContinued') }}</span></span>
              </template>
            </div>
          </div>
        </ToolPanel>

        <ToolPanel
          v-else-if="section.kind === 'candidates'"
          :title="t('tools.browser.detail.titles.candidates')"
          :meta="t('tools.browser.detail.items', { count: section.rows.length })"
          scroll
        >
          <BrowserTable
            :columns="['relation', 'ref', 'role', 'name', 'tagName', 'id', 'classes', 'evidence', 'clickable', 'disabled', 'bounds']"
            :rows="candidateRows(section)"
          />
        </ToolPanel>

        <ToolPanel
          v-else-if="section.kind === 'tabs'"
          :title="t('tools.browser.detail.titles.tabs')"
          :meta="t('tools.browser.detail.items', { count: section.rows.length })"
          scroll
        >
          <BrowserTable :columns="['tabId', 'title', 'url', 'controlled', 'visible', 'loading']" :rows="tabRows(section)" />
        </ToolPanel>

        <ToolPanel
          v-else-if="section.kind === 'table'"
          :title="t(`tools.browser.detail.titles.${section.name}`)"
          :meta="t('tools.browser.detail.items', { count: section.rows.length })"
          scroll
        >
          <BrowserTable :columns="section.columns" :rows="section.rows" />
        </ToolPanel>
      </template>

      <BrowserFold
        v-if="view.rest.length > 0"
        :state-key="`tool:${tool.id}:browser-rest`"
        :label="t('tools.browser.detail.rest')"
        :meta="String(view.rest.length)"
      >
        <ToolPanel scroll>
          <div class="btd-stack">
            <div v-for="group in restGroups" :key="group.source" class="btd-rest">
              <div class="btd-rest-title">{{ t(group.source === 'args' ? 'tools.browser.detail.rawRequest' : 'tools.browser.detail.rawResult') }}</div>
              <dl class="btd-rest-rows">
                <template v-for="entry in group.entries" :key="entry.path">
                  <dt>{{ entry.path }}</dt>
                  <dd>{{ restValue(entry.value) }}</dd>
                </template>
              </dl>
            </div>
          </div>
        </ToolPanel>
      </BrowserFold>
    </template>

    <div v-if="view?.resultUnreadable" class="btd-note">{{ t('tools.browser.detail.unreadable') }}</div>

    <BrowserFold
      v-if="view"
      :state-key="`tool:${tool.id}:browser-raw`"
      :label="t('tools.browser.detail.raw')"
      :initially-open="view.resultUnreadable"
    >
      <div class="btd-raw">
        <ToolPanel :title="t('tools.browser.detail.rawRequest')" :copy-text="tool.arg">
          <OutputPanel :lines="[tool.arg]" />
        </ToolPanel>
        <ToolPanel :title="t('tools.browser.detail.rawResult')" :copy-text="outputText">
          <OutputPanel :lines="tool.output" :empty-text="emptyOutput" />
        </ToolPanel>
      </div>
    </BrowserFold>
    <div v-else class="btd-raw">
      <ToolPanel :title="t('tools.browser.detail.rawRequest')" :copy-text="tool.arg">
        <OutputPanel :lines="[tool.arg]" />
      </ToolPanel>
      <ToolPanel :title="t('tools.browser.detail.rawResult')" :copy-text="outputText">
        <OutputPanel :lines="tool.output" :empty-text="emptyOutput" />
      </ToolPanel>
    </div>
  </div>
</template>

<style scoped>
.btd,
.btd-raw {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.btd-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.btd-error {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.btd-error-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}
.btd-error-code {
  color: var(--color-danger);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-autospace: no-autospace;
}
.btd-error-message {
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.btd-changes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.btd-changes-title,
.btd-changes-note {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  user-select: none;
}
.btd-change-rows {
  display: grid;
  grid-template-columns: fit-content(40%) minmax(0, 1fr);
  gap: var(--space-1) var(--space-4);
  margin: 0;
}
.btd-change-rows dt {
  color: var(--color-text-muted);
  user-select: none;
}
.btd-change-rows dd {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px var(--space-2);
  min-width: 0;
  margin: 0;
}
.btd-before,
.btd-after {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
.btd-before :deep(.bv),
.btd-before :deep(.burl),
.btd-before :deep(.burl-plain),
.btd-before :deep(.burl-host),
.btd-before :deep(.burl-path),
.btd-before :deep(.burl-hash),
.btd-before :deep(.burl-key) {
  color: var(--color-text-faint);
}
.btd-arrow {
  flex: none;
  align-self: center;
  color: var(--color-text-faint);
}
.btd-blocks {
  display: grid;
  grid-template-columns: max-content max-content minmax(0, 1fr);
  gap: 2px var(--space-2);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.btd-block-id,
.btd-block-kind {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: inherit;
  text-autospace: no-autospace;
  user-select: none;
}
.btd-block-text {
  min-width: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.btd-block-text.is-heading {
  font-weight: var(--weight-medium);
}
.btd-block-note {
  margin-left: var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  user-select: none;
}
.btd-rest-title {
  margin-bottom: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  user-select: none;
}
.btd-rest-rows {
  display: grid;
  grid-template-columns: fit-content(50%) minmax(0, 1fr);
  gap: 2px var(--space-4);
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  text-autospace: no-autospace;
}
.btd-rest-rows dt {
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.btd-rest-rows dd {
  min-width: 0;
  margin: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.btd-note {
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
</style>
