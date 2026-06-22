<!-- apps/kimi-web/src/components/LanguageSwitcher.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../i18n';

const { locale } = useI18n();

function choose(code: LocaleCode): void {
  if (locale.value === code) return;
  setLocale(code);
}
</script>

<template>
  <div class="lang-switch" role="group" aria-label="Language">
    <button
      v-for="opt in availableLocales"
      :key="opt.code"
      type="button"
      class="lang-opt"
      :class="{ on: locale === opt.code }"
      :aria-pressed="locale === opt.code"
      @click.stop="choose(opt.code)"
    >{{ opt.label }}</button>
  </div>
</template>

<style scoped>
.lang-switch {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--mono);
}
.lang-opt {
  appearance: none;
  border: none;
  border-left: 1px solid var(--line);
  background: var(--bg);
  color: var(--muted);
  font: inherit;
  font-size: var(--ui-font-size-xs);
  padding: 5px 12px;
  cursor: pointer;
}
.lang-opt:first-child { border-left: none; }
.lang-opt:hover { color: var(--ink); }
.lang-opt.on {
  background: var(--soft);
  color: var(--blue2);
  font-weight: 600;
}
</style>
