<script setup lang="ts">
import { computed } from 'vue';
import { Badge, Card } from '@moonshot-ai/app-ui';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import { frontmatterMetadata } from './lib/frontmatterMetadata';

const props = defineProps<{ source: string }>();
const { t } = useKimiI18n();
const entries = computed(() => frontmatterMetadata(props.source));
</script>

<template>
  <Card size="sm" class="md-frontmatter" role="region" :aria-label="t('filePreview.metadata')">
    <div class="metadata-title">{{ t('filePreview.metadata') }}</div>
    <dl v-if="entries" class="metadata-fields">
      <template v-for="entry in entries" :key="entry.key">
        <dt>{{ entry.key }}</dt>
        <dd>
          <div v-if="entry.tags" class="metadata-tags">
            <span v-for="(tag, index) in entry.tags" :key="index" class="metadata-tag">
              <Badge variant="soft" size="lg">{{ tag }}</Badge>
            </span>
          </div>
          <span v-else class="metadata-value">{{ entry.value }}</span>
        </dd>
      </template>
    </dl>
    <pre v-else class="metadata-source">{{ source }}</pre>
  </Card>
</template>

<style scoped>
.md-frontmatter {
  margin-bottom: var(--space-6);
  font: var(--md-b3)/var(--leading-normal) var(--font-ui);
}
.metadata-title {
  margin-bottom: var(--space-2);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.metadata-fields {
  display: grid;
  grid-template-columns: fit-content(40%) minmax(0, 1fr);
  gap: var(--space-1) var(--space-4);
  margin: 0;
}
.metadata-fields dt {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.metadata-fields dd {
  min-width: 0;
  margin: 0;
  color: var(--color-text);
}
.metadata-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.metadata-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.metadata-tag {
  max-width: 100%;
  overflow-x: auto;
}
.metadata-source {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-family: var(--font-mono);
}
</style>
