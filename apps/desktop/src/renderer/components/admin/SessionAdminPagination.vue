<!-- apps/desktop/src/renderer/components/admin/SessionAdminPagination.vue -->
<!-- Session admin pager: total count on the left; page-size select (10/20/50/
     100) + folded page numbers (1 … 4 5 6 … 10) + prev/next on the right.
     Page numbers hide entirely when there is nothing to page (prototype). -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import FilterSelect from './FilterSelect.vue';
import { pageItems } from './pageItems';

const props = defineProps<{
  page: number;
  pageSize: number;
  total: number;
}>();

const emit = defineEmits<{
  'update:page': [page: number];
  'update:pageSize': [pageSize: number];
}>();

const { t } = useI18n();

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const items = computed(() => pageItems(props.page, totalPages.value));

const sizeOptions = computed(() =>
  PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: t('admin.pageSize', { n }) })),
);
const sizeValue = computed({
  get: () => String(props.pageSize),
  set: (v: string) => emit('update:pageSize', Number(v)),
});
</script>

<template>
  <div class="sa-pager">
    <span class="sa-total">{{ t('admin.total', { n: total }) }}</span>
    <div class="sa-pager-right">
      <FilterSelect v-model="sizeValue" :options="sizeOptions" :aria-label="t('admin.pageSize', { n: pageSize })" />
      <div v-if="total > 0" class="sa-pages">
        <button
          class="sa-pg"
          type="button"
          :disabled="page === 1"
          :title="t('admin.prevPage')"
          :aria-label="t('admin.prevPage')"
          @click="emit('update:page', page - 1)"
        >
          <Icon name="chevron-left" size="sm" />
        </button>
        <template v-for="(it, i) in items" :key="i">
          <span v-if="it === '…'" class="sa-ellipsis">…</span>
          <button
            v-else
            class="sa-pg"
            :class="{ cur: it === page }"
            type="button"
            @click="emit('update:page', it)"
          >
            {{ it }}
          </button>
        </template>
        <button
          class="sa-pg"
          type="button"
          :disabled="page === totalPages"
          :title="t('admin.nextPage')"
          :aria-label="t('admin.nextPage')"
          @click="emit('update:page', page + 1)"
        >
          <Icon name="chevron-right" size="sm" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sa-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}
.sa-total {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.sa-pager-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.sa-pages {
  display: flex;
  align-items: center;
  gap: var(--space-05);
}
.sa-pg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 var(--space-1-5);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.sa-pg:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.sa-pg.cur {
  background: var(--color-selected);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.sa-pg.cur:hover {
  background: var(--color-selected);
}
.sa-pg:disabled {
  opacity: 0.38;
  cursor: default;
}
.sa-pg:disabled:hover {
  background: transparent;
  color: var(--color-text-muted);
}
.sa-ellipsis {
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  user-select: none;
}
</style>
