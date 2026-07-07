<!-- apps/kimi-web/src/components/settings/LanguageSwitcher.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../../i18n';
import SegmentedControl from '../ui/SegmentedControl.vue';

const { locale } = useI18n();

const options = availableLocales.map((l) => ({ value: l.code, label: l.label }));

function choose(code: string): void {
  if (locale.value === code) return;
  setLocale(code as LocaleCode);
}
</script>

<template>
  <SegmentedControl :model-value="locale" :options="options" @update:model-value="choose" />
</template>
