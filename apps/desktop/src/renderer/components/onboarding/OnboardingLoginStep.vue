<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard, hasDesktopBridge, resolveOAuthLoginCards } from '@moonshot-ai/app-core/lib';
import type { OAuthRegionSupport } from '@moonshot-ai/app-core/lib';
import {
  useIsMobile,
  useOAuthLoginFlow,
  type OAuthLoginFlowCallbacks,
  type OAuthRegion,
} from '@moonshot-ai/app-client/composables';
import { withDesktopLoginSource } from '../../lib/loginSource';
import { createDesktopAuthWake, createDesktopOAuthAutoOpen, createWebAuthWake, createWebOAuthAutoOpen, isHttpUrl } from '@moonshot-ai/app-client/lib';
import { ActionCard, AuthStateIcon, Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import BrandLogo from './BrandLogo.vue';

const { t } = useI18n();

const desktopLoginBridge = hasDesktopBridge();
const isMobile = useIsMobile();

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

const emit = defineEmits<{ success: []; addProvider: [] }>();

const phase = ref<'choice' | 'flow'>('choice');

const { step, pollError, flow, secondsLeft, autoOpenBlocked, errorMessage, startFlow, cancelFlow } = useOAuthLoginFlow({
  onStartOAuthLogin: props.onStartOAuthLogin,
  onPollOAuthLogin: props.onPollOAuthLogin,
  onCancelOAuthLogin: props.onCancelOAuthLogin,
  onSuccess: () => emit('success'),
  autoOpen: desktopLoginBridge ? createDesktopOAuthAutoOpen(withDesktopLoginSource) : createWebOAuthAutoOpen(),
  authWake: desktopLoginBridge ? createDesktopAuthWake() : createWebAuthWake(),
});

const copied = ref(false);

const REGION_CARDS: ReadonlyArray<{ region: OAuthRegion; titleKey: string; hintKey: string }> = [
  { region: 'mainland-cn', titleKey: 'onboarding.login.kimiCnTitle', hintKey: 'onboarding.login.kimiCnHint' },
  { region: 'global', titleKey: 'onboarding.login.kimiOverseasTitle', hintKey: 'onboarding.login.kimiOverseasHint' },
];

const FALLBACK_CARD = { titleKey: 'onboarding.login.kimiTitle', hintKey: 'onboarding.login.kimiHint' } as const;

const regionSupport = ref<OAuthRegionSupport>('pending');
const loginCards = computed(() =>
  resolveOAuthLoginCards(regionSupport.value, REGION_CARDS, FALLBACK_CARD),
);

onMounted(() => {
  void props.onGetOAuthRegion?.().then((region) => {
    regionSupport.value = region === null ? 'unsupported' : 'supported';
  });
});

const verificationUriComplete = computed(() =>
  flow.value
    ? desktopLoginBridge
      ? withDesktopLoginSource(flow.value.verificationUriComplete)
      : flow.value.verificationUriComplete
    : '',
);

function startLogin(region?: OAuthRegion): void {
  phase.value = 'flow';
  void startFlow(region);
}

function backToChoice(): void {
  cancelFlow();
  phase.value = 'choice';
}

async function copyLink(): Promise<void> {
  if (!flow.value) return;
  const ok = await copyTextToClipboard(verificationUriComplete.value);
  if (!ok) return;
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

function reopenVerification(): void {
  if (!isHttpUrl(verificationUriComplete.value)) return;
  window.open(verificationUriComplete.value, '_blank', 'noopener,noreferrer');
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <div v-if="signedIn" class="ls-done-card">
    <span class="ls-done-badge"><Icon name="check" size="sm" /></span>
    <div class="ls-card-text">
      <div class="ls-card-title">{{ t('onboarding.login.loggedInTitle') }}</div>
      <div class="ls-card-hint">{{ t('onboarding.login.loggedInHint') }}</div>
    </div>
  </div>

  <div v-else-if="phase === 'choice'" class="ls-cards">
    <ActionCard
      v-for="card in loginCards"
      :key="card.region ?? 'oauth'"
      :disabled="card.disabled"
      @select="startLogin(card.region)"
    >
      <template #leading><BrandLogo :size="40" /></template>
      {{ t(card.titleKey) }}
      <template v-if="card.hintKey" #hint>{{ t(card.hintKey) }}</template>
    </ActionCard>
    <!-- Third-party entry: lands on Settings → Providers (the parent completes
         onboarding first, same as skipping the login step). Parked on mobile
         for now — desktop keeps the entry. -->
    <ActionCard v-if="!isMobile" @select="emit('addProvider')">
      <template #leading><span class="ls-card-icon"><Icon name="bolt" size="lg" /></span></template>
      {{ t('onboarding.login.customProviderTitle') }}
      <template #hint>{{ t('onboarding.login.customProviderHint') }}</template>
    </ActionCard>
  </div>

  <!-- Device-code flow -->
  <div v-else class="ls-flow">
    <!-- Starting (brief spinner) -->
    <div v-if="step === 'starting'" class="ls-center">
      <Spinner size="md" />
      <span class="ls-center-text">{{ t('login.starting') }}</span>
    </div>

    <!-- Authorization wait: the verification page auto-opened in the browser
         (one placeholder tab per flow); the wizard just waits for the daemon
         to confirm. -->
    <div v-else-if="step === 'device-code' && flow" class="ls-device">
      <div class="ls-hero">
        <span class="ls-hero-icon"><BrandLogo :size="48" /></span>
        <div v-if="autoOpenBlocked" class="ls-hero-title">{{ t('login.blockedTitle') }}</div>
        <div class="ls-hero-hint">{{ autoOpenBlocked ? t('login.blockedHint') : t('login.openedHint', { time: formatSeconds(secondsLeft) }) }}</div>
      </div>

      <!-- The automatic open failed (popup blocked / tab closed): surface a
           prominent manual button. -->
      <Button v-if="autoOpenBlocked" variant="primary" @click="reopenVerification">
        {{ t('login.authorizeInBrowser') }}
        <Icon name="external-link" size="sm" />
      </Button>

      <!-- Quiet manual fallback: copy the link via an inline text button. -->
      <div class="ls-manual">
        <span class="ls-manual-label">
          {{ t('login.notOpened') }}
          <Button variant="text" class="ls-copy-text" :class="{ 'is-copied': copied }" @click="copyLink">
            {{ copied ? t('login.copied') : t('login.copyLink') }}
          </Button>
        </span>
      </div>
    </div>

    <!-- Success -->
    <div v-else-if="step === 'success'" class="ls-center">
      <AuthStateIcon kind="success" />
      <span class="ls-center-text ls-success-text">{{ t('login.success') }}</span>
      <span class="ls-center-hint">{{ t('login.successHint') }}</span>
    </div>

    <!-- Denied (the user cancelled on the authorization page) -->
    <template v-else-if="step === 'denied'">
      <div class="ls-center">
        <AuthStateIcon kind="expired" />
        <span class="ls-center-text ls-err-text">{{ t('login.deniedTitle') }}</span>
        <span class="ls-center-hint">{{ t('login.expiredHint') }}</span>
      </div>
      <div class="ls-actions">
        <Button variant="secondary" @click="backToChoice">{{ t('onboarding.back') }}</Button>
        <Button variant="primary" @click="startFlow()">{{ t('login.retry') }}</Button>
      </div>
    </template>

    <!-- Expired / Cancelled -->
    <template v-else-if="step === 'expired'">
      <div class="ls-center">
        <AuthStateIcon kind="expired" />
        <span class="ls-center-text ls-err-text">{{ t('login.expiredTitle') }}</span>
        <span class="ls-center-hint">{{ t('login.expiredHint') }}</span>
      </div>
      <div class="ls-actions">
        <Button variant="secondary" @click="backToChoice">{{ t('onboarding.back') }}</Button>
        <Button variant="primary" @click="startFlow()">{{ t('login.retry') }}</Button>
      </div>
    </template>

    <!-- Error (endpoint missing, network failure, or repeated poll failures) -->
    <template v-else-if="step === 'error'">
      <div class="ls-center">
        <AuthStateIcon kind="error" />
        <span class="ls-center-text ls-warn-text">
          {{ pollError ? t('login.pollErrorTitle') : t('login.failedTitle') }}
        </span>
        <span class="ls-center-hint">
          {{ pollError ? t('login.pollErrorHint') : (errorMessage ?? t('login.errorHint')) }}
        </span>
      </div>
      <div class="ls-actions">
        <Button variant="secondary" @click="backToChoice">{{ t('onboarding.back') }}</Button>
        <Button variant="primary" @click="startFlow()">{{ t('login.retry') }}</Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ls-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.ls-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--color-text-muted);
}
.ls-card-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.ls-card-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ls-card-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}

.ls-done-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-success-bd);
  border-radius: var(--radius-lg);
}
.ls-done-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  background: var(--color-success-soft);
  color: var(--color-success);
  flex: none;
}

.ls-flow {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.ls-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6) 0 var(--space-2);
  text-align: center;
}
.ls-center-text {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ls-success-text { color: var(--color-success); }
.ls-err-text { color: var(--color-danger); }
.ls-warn-text { color: var(--color-warning); }
.ls-center-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.ls-device {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ls-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
}
.ls-hero-icon {
  display: inline-flex;
  margin-bottom: var(--space-1);
}
.ls-hero-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ls-hero-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
  font-variant-numeric: tabular-nums;
}

.ls-manual {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}
.ls-manual-label {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.ls-copy-text { margin-left: var(--space-2); }
.ls-copy-text.is-copied { color: var(--color-success); text-decoration: none; }
.ls-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

@media (max-width: 640px) {
  .ls-actions {
    flex-wrap: wrap;
  }
}
</style>
