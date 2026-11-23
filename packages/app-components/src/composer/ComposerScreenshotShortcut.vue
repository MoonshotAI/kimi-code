<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, Kbd, Tooltip } from '@moonshot-ai/app-ui';

const props = defineProps<{
  keys: string[];
  unavailable?: boolean;
  failureReason?: 'channel-disabled' | 'conflicted' | 'invalid';
}>();
const emit = defineEmits<{ configure: [] }>();
const { t } = useI18n();

const channelDisabled = computed(() => props.unavailable === true && props.failureReason === 'channel-disabled');
const unavailableText = computed(() => (channelDisabled.value ? t('shortcuts.channelDisabled') : t('shortcuts.notGlobal')));
const tooltipText = computed(() => (props.unavailable ? unavailableText.value : t('shortcuts.edit')));
</script>

<template>
  <span class="shortcut">
    <Tooltip :text="tooltipText">
      <Button
        variant="ghost"
        size="xs"
        role="menuitem"
        :aria-label="t('shortcuts.edit')"
        :class="{ 'shortcut-unavailable': unavailable && !channelDisabled }"
        @mousedown.prevent
        @click="emit('configure')"
      >
        <Icon v-if="unavailable" name="alert-triangle" size="sm" :label="unavailableText" />
        <Kbd v-if="keys.length" :keys="keys" />
        <span v-else>{{ t('shortcuts.unassigned') }}</span>
      </Button>
    </Tooltip>
  </span>
</template>

<style scoped>
.shortcut {
  display: inline-flex;
  align-items: center;
}
.shortcut-unavailable {
  color: var(--color-warning);
}
</style>
