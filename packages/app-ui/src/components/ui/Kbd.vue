<script setup lang="ts">
import { computed } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import { formatShortcutKeys, shortcutKeyNames, type ShortcutKeys } from '@moonshot-ai/app-core/lib';
import Icon from './Icon.vue';

const props = defineProps<{
  keys: ShortcutKeys;
  variant?: 'default' | 'button';
  literal?: boolean;
}>();

const { t } = useKimiI18n();

interface KeyDisplay {
  id: string;
  text: string;
  icon?: string;
  name?: string;
}

const displays = computed<KeyDisplay[]>(() => {
  if (props.literal === true) return shortcutKeyNames(props.keys).map((raw) => ({ id: raw, text: raw }));
  return formatShortcutKeys(props.keys).map((cap) => ({
    id: cap.name,
    text: cap.text,
    icon: cap.icon,
    name: cap.spokenKey === undefined ? undefined : t(cap.spokenKey),
  }));
});
</script>

<template>
  <span v-if="displays.length > 0" class="ui-kbd" :class="{ 'ui-kbd--button': variant === 'button' }">
    <kbd
      v-for="d in displays"
      :key="d.id"
      class="ui-kbd__key"
      :class="{ 'ui-kbd__key--icon': d.icon !== undefined, 'ui-kbd__key--wide': d.icon === 'key-backspace' }"
    >
      <template v-if="d.icon !== undefined">
        <Icon :name="d.icon" size="md" />
        <span class="ui-kbd__sr">{{ d.name }}</span>
      </template>
      <template v-else>{{ d.text }}</template>
    </kbd>
  </span>
</template>

<style scoped>
.ui-kbd {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.ui-kbd__key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--kbd-min-width);
  height: var(--kbd-height);
  padding: 0 var(--kbd-padding-x);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font-family: var(--font-kbd);
  font-size: var(--kbd-font-size);
  line-height: var(--leading-solid);
}
.ui-kbd__key--icon :deep(.kw-icon) {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0 -3.5px;
  color: inherit !important;
}
.ui-kbd__key--wide :deep(.kw-icon) {
  margin: 0 -2px;
}
.ui-kbd__sr {
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
.ui-kbd--button .ui-kbd__key {
  background: color-mix(in srgb, currentColor 16%, transparent);
  border-color: color-mix(in srgb, currentColor 35%, transparent);
  box-shadow: 0 1px 0 color-mix(in srgb, currentColor 12%, transparent);
}
</style>
