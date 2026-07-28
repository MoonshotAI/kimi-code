<!-- apps/web/src/components/settings/LanguageSwitcher.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../../i18n';
import { track } from '../../lib/track';
import { SegmentedControl } from '@moonshot-ai/web-ui';

const { locale } = useI18n();

const options = availableLocales.map((l) => ({ value: l.code, label: l.label }));

function isLocaleCode(code: string): code is LocaleCode {
  return availableLocales.some((locale) => locale.code === code);
}

function choose(code: string): void {
  if (!isLocaleCode(code)) return;
  if (locale.value === code) return;
  setLocale(code);
  track('settings_changed', { key: 'language', value: code });
}
</script>

<template>
  <SegmentedControl :model-value="locale" :options="options" @update:model-value="choose" />
</template>
