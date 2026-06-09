<!-- apps/kimi-web/src/components/Onboarding.vue -->
<!-- First-run onboarding overlay: a short welcome + the two preferences
     (language, theme). Both apply live. Re-openable from the settings popover.
     Preferences can be changed any time later, so there's nothing to "lose". -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../i18n';
import type { Theme } from '../composables/useKimiWebClient';

const props = defineProps<{ theme: Theme }>();
const emit = defineEmits<{ setTheme: [theme: Theme]; complete: [] }>();

const { t, locale } = useI18n();

function chooseLocale(code: LocaleCode): void {
  if (locale.value !== code) setLocale(code);
}

// Theme is chosen LOCALLY and only applied on "Get started" (so the screen
// behind the overlay doesn't flicker while the user is comparing). Defaults to
// the current app theme (Modern for new users).
const selectedTheme = ref<Theme>(props.theme);

function finish(): void {
  if (selectedTheme.value !== props.theme) emit('setTheme', selectedTheme.value);
  emit('complete');
}
</script>

<template>
  <div class="ob-backdrop">
    <div class="ob-card" role="dialog" aria-modal="true" :aria-label="t('onboarding.title')">
      <div class="ob-brand">
        <span class="ob-logo">K</span>
        <div>
          <div class="ob-title">{{ t('onboarding.title') }}</div>
          <div class="ob-sub">{{ t('onboarding.subtitle') }}</div>
        </div>
      </div>

      <!-- Language -->
      <section class="ob-sec">
        <div class="ob-label">{{ t('onboarding.languageLabel') }}</div>
        <div class="ob-seg" role="group">
          <button
            v-for="opt in availableLocales"
            :key="opt.code"
            type="button"
            class="ob-seg-btn"
            :class="{ on: locale === opt.code }"
            :aria-pressed="locale === opt.code"
            @click="chooseLocale(opt.code)"
          >{{ opt.label }}</button>
        </div>
      </section>

      <!-- Theme -->
      <section class="ob-sec">
        <div class="ob-label">{{ t('onboarding.themeLabel') }}</div>
        <div class="ob-themes">
          <button
            type="button"
            class="ob-theme"
            :class="{ on: selectedTheme === 'modern' }"
            :aria-pressed="selectedTheme === 'modern'"
            @click="selectedTheme = 'modern'"
          >
            <span class="ob-theme-prev modern" aria-hidden="true">
              <span class="bub u"></span><span class="bub a"></span>
            </span>
            <span class="ob-theme-name">{{ t('theme.modern') }}</span>
            <span class="ob-theme-desc">{{ t('onboarding.modernDesc') }}</span>
          </button>
          <button
            type="button"
            class="ob-theme"
            :class="{ on: selectedTheme === 'terminal' }"
            :aria-pressed="selectedTheme === 'terminal'"
            @click="selectedTheme = 'terminal'"
          >
            <span class="ob-theme-prev terminal" aria-hidden="true">
              <span class="l a"></span><span class="l b"></span><span class="l c"></span>
            </span>
            <span class="ob-theme-name">{{ t('theme.terminal') }}</span>
            <span class="ob-theme-desc">{{ t('onboarding.terminalDesc') }}</span>
          </button>
        </div>
      </section>

      <button type="button" class="ob-start" @click="finish">{{ t('onboarding.start') }}</button>
    </div>
  </div>
</template>

<style scoped>
.ob-backdrop {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(20, 23, 28, 0.42);
  backdrop-filter: blur(3px);
}
.ob-card {
  width: 100%;
  max-width: 440px;
  max-height: 92vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(20, 23, 28, 0.28);
  padding: 22px 22px 20px;
}
.ob-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.ob-logo {
  width: 38px; height: 38px; flex: none;
  background: var(--ink); color: #fff; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--mono); font-weight: 700; font-size: 18px;
}
.ob-title { color: var(--ink); font-size: 16px; font-weight: 700; }
.ob-sub { color: var(--muted); font-size: 14px; margin-top: 1px; }

.ob-sec { margin-bottom: 16px; }
.ob-label { color: var(--dim); font-size: 11.5px; font-weight: 600; margin-bottom: 7px; }

/* segmented (language) */
.ob-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.ob-seg-btn {
  border: none; background: var(--bg); color: var(--muted);
  font-family: var(--mono); font-size: 12px; padding: 6px 16px; cursor: pointer;
}
.ob-seg-btn + .ob-seg-btn { border-left: 1px solid var(--line); }
.ob-seg-btn.on { background: var(--soft); color: var(--blue2); font-weight: 600; }

/* theme cards */
.ob-themes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ob-theme {
  display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
  border: 1px solid var(--line); border-radius: 12px; padding: 10px; cursor: pointer;
  background: var(--bg); text-align: left;
}
.ob-theme.on { border-color: var(--blue); box-shadow: inset 0 0 0 1px var(--blue); }
.ob-theme-prev {
  width: 100%; height: 52px; border-radius: 8px; overflow: hidden;
  display: flex; flex-direction: column; gap: 4px; padding: 8px; margin-bottom: 2px;
}
.ob-theme-prev.terminal { background: #f3f5f8; }
.ob-theme-prev.terminal .l { height: 4px; border-radius: 2px; background: #cfd6df; }
.ob-theme-prev.terminal .l.a { width: 70%; } .ob-theme-prev.terminal .l.b { width: 90%; } .ob-theme-prev.terminal .l.c { width: 55%; background: #bcd3f2; }
.ob-theme-prev.modern { background: #f4f6fa; align-items: stretch; }
.ob-theme-prev.modern .bub { height: 14px; border-radius: 7px; }
.ob-theme-prev.modern .bub.u { width: 60%; align-self: flex-end; background: var(--bluebg); border: 1px solid var(--blueln); }
.ob-theme-prev.modern .bub.a { width: 80%; background: #fff; border: 1px solid var(--line); }
.ob-theme-name { color: var(--ink); font-size: 12.5px; font-weight: 600; }
.ob-theme-desc { color: var(--muted); font-size: 10.5px; line-height: 1.4; }

.ob-start {
  width: 100%; margin-top: 6px;
  background: var(--blue); color: #fff; border: none; border-radius: 10px;
  font-size: 13.5px; font-weight: 600; padding: 11px; cursor: pointer;
}
.ob-start:hover { background: var(--blue2); }

@media (max-width: 480px) {
  .ob-themes { grid-template-columns: 1fr; }
}
</style>
