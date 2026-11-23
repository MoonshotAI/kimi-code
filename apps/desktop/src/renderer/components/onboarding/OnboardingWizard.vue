<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearance, type ColorScheme } from '@moonshot-ai/app-core';
import { Button } from '@moonshot-ai/app-ui';
import { availableLocales, setLocale, type LocaleCode } from '../../i18n';
import { type OAuthLoginFlowCallbacks, type OAuthRegion } from '@moonshot-ai/app-client/composables';
import { track } from '../../lib/track';
import BrandLogo from './BrandLogo.vue';
import OnboardingLoginStep from './OnboardingLoginStep.vue';

const { t, locale } = useI18n();

const props = defineProps<{
  signedIn: boolean;
  onStartOAuthLogin: OAuthLoginFlowCallbacks['onStartOAuthLogin'];
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
    errorMessage?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
  onGetOAuthRegion?: () => Promise<OAuthRegion | null>;
}>();

const emit = defineEmits<{ complete: []; loginSuccess: []; addProvider: [] }>();

const STEPS = ['preferences', 'login'] as const;
type WizardStep = (typeof STEPS)[number];
const stepIndex = ref(0);
const step = computed<WizardStep>(() => STEPS[stepIndex.value] ?? 'preferences');

function next(): void {
  if (stepIndex.value < STEPS.length - 1) stepIndex.value++;
}
function back(): void {
  if (stepIndex.value > 0) stepIndex.value--;
}

const wizardStartedAt = Date.now();
let stepStartedAt = wizardStartedAt;
let outcomeReported = false;
const reportedStepIndexes = new Set<number>();

function reportStepExit(skipped?: boolean): void {
  if (reportedStepIndexes.has(stepIndex.value)) return;
  reportedStepIndexes.add(stepIndex.value);
  track('onboarding_step', {
    step: step.value,
    step_index: stepIndex.value,
    total_steps: STEPS.length,
    duration_ms: Date.now() - stepStartedAt,
    ...(skipped === true ? { skipped: true } : {}),
  });
}

function reportOutcome(outcome: 'completed' | 'abandoned'): void {
  if (outcomeReported) return;
  outcomeReported = true;
  const totalDuration = Math.min(Date.now() - wizardStartedAt, 3_600_000);
  if (outcome === 'completed') {
    track('onboarding_completed', { total_duration_ms: totalDuration });
  } else {
    track('onboarding_abandoned', { last_step: step.value, total_duration_ms: totalDuration });
  }
}

watch(step, (_newStep, oldStep) => {
  const oldIndex = STEPS.indexOf(oldStep);
  if (!reportedStepIndexes.has(oldIndex)) {
    reportedStepIndexes.add(oldIndex);
    track('onboarding_step', {
      step: oldStep,
      step_index: oldIndex,
      total_steps: STEPS.length,
      duration_ms: Date.now() - stepStartedAt,
    });
  }
  stepStartedAt = Date.now();
});

function skip(): void {
  reportStepExit(true);
  reportOutcome(stepIndex.value === 0 ? 'abandoned' : 'completed');
  emit('complete');
}

function finish(): void {
  reportStepExit();
  reportOutcome('completed');
  emit('complete');
}

function onAddProvider(): void {
  reportStepExit();
  reportOutcome('completed');
  emit('addProvider');
}

function chooseLocale(code: LocaleCode): void {
  if (locale.value !== code) setLocale(code);
}

const { colorScheme, setColorScheme } = useAppearance();
const themeOptions: ReadonlyArray<{ value: ColorScheme; labelKey: string }> = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

function onLoginSuccess(): void {
  reportStepExit();
  reportOutcome('completed');
  emit('loginSuccess');
}
</script>

<template>
  <div class="wizard" role="dialog" aria-modal="true" :aria-label="t('onboarding.welcome.title')">
    <div class="wiz-body">
      <section v-if="step === 'preferences'" class="wiz-step">
        <BrandLogo :size="72" />
        <h1 class="wiz-title">{{ t('onboarding.welcome.title') }}</h1>
        <p class="wiz-sub">{{ t('onboarding.welcome.subtitle') }}</p>

        <div class="pref-group">
          <div class="pref-label">{{ t('onboarding.welcome.languageLabel') }}</div>
          <div class="lang-cards">
            <button
              v-for="l in availableLocales"
              :key="l.code"
              class="opt-card lang-card"
              :class="{ selected: locale === l.code }"
              type="button"
              @click="chooseLocale(l.code)"
            >
              <span class="opt-radio" :class="{ on: locale === l.code }" />
              <span class="opt-label">{{ l.label }}</span>
            </button>
          </div>
        </div>

        <div class="pref-group">
          <div class="pref-label">{{ t('onboarding.welcome.themeLabel') }}</div>
          <div class="theme-cards">
            <button
              v-for="opt in themeOptions"
              :key="opt.value"
              class="opt-card theme-card"
              :class="{ selected: colorScheme === opt.value }"
              type="button"
              @click="setColorScheme(opt.value)"
            >
              <span class="tp" :class="`tp-${opt.value}`" aria-hidden="true">
                <template v-if="opt.value === 'system'">
                  <span class="tp-half tp-half-light">
                    <span class="tp-side" /><span class="tp-lines"><span /><span /><span /></span>
                  </span>
                  <span class="tp-half tp-half-dark">
                    <span class="tp-side" /><span class="tp-lines"><span /><span /><span /></span>
                  </span>
                </template>
                <template v-else>
                  <span class="tp-side" /><span class="tp-lines"><span /><span /><span /></span>
                </template>
              </span>
              <span class="opt-label">{{ t(opt.labelKey) }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- Step 2 — model service (Kimi login) -->
      <section v-else class="wiz-step">
        <BrandLogo :size="72" />
        <h1 class="wiz-title">{{ t('onboarding.login.title') }}</h1>
        <p class="wiz-sub">{{ t('onboarding.login.subtitle') }}</p>
        <!-- The login body floats to the vertical middle of the space between
             the (top-anchored) subtitle and the bottom footer. -->
        <div class="wiz-step-fill">
          <OnboardingLoginStep
            :signed-in="props.signedIn"
            :on-start-o-auth-login="props.onStartOAuthLogin"
            :on-poll-o-auth-login="props.onPollOAuthLogin"
            :on-cancel-o-auth-login="props.onCancelOAuthLogin"
            :on-get-o-auth-region="props.onGetOAuthRegion"
            @success="onLoginSuccess"
            @add-provider="onAddProvider"
          />
        </div>
      </section>

      <!-- Footer navigation: primary CTA first, ghost actions below it. -->
      <div class="wiz-foot">
        <Button
          v-if="step === 'preferences'"
          variant="primary"
          size="lg"
          class="wiz-primary"
          @click="next"
        >
          {{ t('onboarding.continue') }}
        </Button>
        <Button
          v-else-if="step === 'login' && props.signedIn"
          variant="primary"
          size="lg"
          class="wiz-primary"
          @click="finish"
        >
          {{ t('onboarding.login.finish') }}
        </Button>
        <div class="wiz-foot-actions">
          <Button v-if="stepIndex > 0" variant="ghost" @click="back">
            {{ t('onboarding.back') }}
          </Button>
          <Button
            v-if="!(step === 'login' && props.signedIn)"
            variant="ghost"
            @click="skip"
          >
            {{ step === 'login' ? t('onboarding.login.skip') : t('onboarding.skip') }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  color: var(--color-text);
  overflow-y: auto;
  font-family: var(--font-ui);
}

.wiz-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(560px, 100%);
  margin: 0 auto;
  padding: max(var(--space-8), 12vh) var(--space-5) var(--space-6);
}
.wiz-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  flex: 1;
  min-height: 0;
}
.wiz-step-fill {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
}
.wiz-title {
  margin: var(--space-4) 0 0;
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  color: var(--color-text);
  text-align: center;
}
.wiz-sub {
  margin: var(--space-2) 0 var(--space-6);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  text-align: center;
  max-width: 460px;
}

.pref-group {
  width: 100%;
  margin-bottom: var(--space-5);
}
.pref-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
  margin-bottom: var(--space-2);
}

.opt-card {
  display: flex;
  align-items: center;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  font-family: var(--font-ui);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.opt-card:hover { border-color: var(--color-line-strong); }
.opt-card:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring-strong);
}
.opt-card.selected {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
.opt-label {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.lang-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
  width: 100%;
}
.lang-card {
  gap: var(--space-3);
  padding: var(--space-4);
}
.opt-radio {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  border: var(--p-hairline) solid var(--color-line-strong);
  background: var(--color-surface-raised);
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.opt-radio::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: transparent;
  transition: background var(--duration-fast) var(--ease-out);
}
.opt-radio.on {
  border-color: var(--color-accent);
}
.opt-radio.on::after {
  background: var(--color-accent);
}

.theme-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
  width: 100%;
}
.theme-card {
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
}
.tp {
  display: flex;
  width: 100%;
  aspect-ratio: 16 / 10;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.tp-light { background: rgb(255 255 255); }
.tp-dark { background: rgb(13 17 23); }
.tp-half {
  flex: 1;
  display: flex;
  min-width: 0;
}
.tp-half-light { background: rgb(255 255 255); }
.tp-half-dark { background: rgb(13 17 23); }
.tp-side {
  width: 30%;
  flex: none;
}
.tp-light .tp-side,
.tp-half-light .tp-side { background: rgb(0 0 0 / 0.05); }
.tp-dark .tp-side,
.tp-half-dark .tp-side { background: rgb(255 255 255 / 0.07); }
.tp-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14% 12%;
}
.tp-lines span {
  height: 6px;
  border-radius: var(--radius-full);
}
.tp-lines span:nth-child(1) { width: 62%; }
.tp-lines span:nth-child(2) { width: 88%; }
.tp-lines span:nth-child(3) { width: 44%; }
.tp-light .tp-lines span,
.tp-half-light .tp-lines span { background: rgb(0 0 0 / 0.14); }
.tp-dark .tp-lines span,
.tp-half-dark .tp-lines span { background: rgb(255 255 255 / 0.22); }

.wiz-foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: auto;
  padding: var(--space-8) 0 max(var(--space-8), 8vh);
}
.wiz-foot-actions {
  display: flex;
  gap: var(--space-3);
  min-height: 32px;
  align-items: center;
}
.wiz-primary {
  min-width: 140px;
}

@media (max-width: 640px) {
  .theme-cards { gap: var(--space-2); }
}
</style>
