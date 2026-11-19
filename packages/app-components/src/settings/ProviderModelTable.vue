<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { emptyModelRow, type ModelRow } from '@moonshot-ai/app-core/lib';
import { Button, Icon, IconButton, Input } from '@moonshot-ai/app-ui';

withDefaults(
  defineProps<{
    managed?: boolean;
  }>(),
  { managed: false },
);

const rows = defineModel<ModelRow[]>({ required: true });
const emit = defineEmits<{ change: [] }>();

const { t } = useI18n();

const rowKeys = new WeakMap<ModelRow, number>();
let rowKeySeq = 0;
function rowKey(row: ModelRow): number {
  let key = rowKeys.get(row);
  if (key === undefined) {
    key = ++rowKeySeq;
    rowKeys.set(row, key);
  }
  return key;
}

function addRow(): void {
  rows.value = [...rows.value, emptyModelRow()];
  emit('change');
}

function removeRow(row: ModelRow): void {
  if (rows.value.length <= 1) return;
  rows.value = rows.value.filter((item) => item !== row);
  emit('change');
}
</script>

<template>
  <div class="pmt">
    <div class="pmt-grid pmt-head">
      <span>{{ t('providers.colModelId') }}<span class="req"> *</span></span>
      <span>{{ t('providers.colContext') }}<span class="req"> *</span></span>
      <span>{{ t('providers.colDisplayName') }}</span>
      <span />
    </div>
    <div v-for="row in rows" :key="rowKey(row)" class="pmt-grid">
      <Input
        v-model="row.model"
        size="sm"
        :placeholder="t('providers.modelIdPlaceholder')"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
        @input="emit('change')"
      />
      <Input
        v-model="row.maxContextSize"
        size="sm"
        inputmode="numeric"
        :placeholder="t('providers.modelContextPlaceholder')"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
        @input="emit('change')"
      />
      <Input
        v-model="row.displayName"
        size="sm"
        :placeholder="t('providers.modelNamePlaceholder')"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
        @input="emit('change')"
      />
      <IconButton
        v-if="!managed"
        size="sm"
        :label="t('providers.removeModel')"
        :tooltip="t('providers.removeModel')"
        :disabled="rows.length <= 1"
        @click="removeRow(row)"
      >
        <Icon name="trash" size="sm" />
      </IconButton>
      <span v-else />
    </div>
    <div v-if="!managed">
      <Button variant="ghost" size="sm" @click="addRow">
        <Icon name="plus" size="sm" />
        {{ t('providers.addModel') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.pmt { display: flex; flex-direction: column; gap: var(--space-2); }
.pmt-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.7fr) minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
}
.pmt-head {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.req { color: var(--color-danger); }

@media (max-width: 640px) {
  .pmt-grid { grid-template-columns: minmax(0, 1fr) auto; }
}
</style>
