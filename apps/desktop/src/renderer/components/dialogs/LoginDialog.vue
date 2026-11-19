<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard, hasDesktopBridge, resolveOAuthLoginCards } from '@moonshot-ai/app-core/lib';
import type { OAuthLoginCardSpec, OAuthRegionSupport } from '@moonshot-ai/app-core/lib';
import {
  useOAuthLoginFlow,
  type OAuthLoginFlowCallbacks,
  type OAuthRegion,
} from '@moonshot-ai/app-client/composables';
import { withDesktopLoginSource } from '../../lib/loginSource';
import { createDesktopAuthWake, createDesktopOAuthAutoOpen, createWebAuthWake, createWebOAuthAutoOpen, isHttpUrl } from '@moonshot-ai/app-client/lib';
import { ActionCard, AuthStateIcon, Button, Dialog, Icon, Spinner } from '@moonshot-ai/app-ui';
import BrandLogo from '../onboarding/BrandLogo.vue';

const { t } = useI18n();

const desktopLoginBridge = hasDesktopBridge();

const open = ref(true);

const emit = defineEmits<{
  success: [];
  close: [];
}>();

const props = defineProps<{
  onStartOAuthLogin: OAuthLoginFlowCallbacks['onStartOAuthLogin'];
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
    errorMessage?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
  onGetOAuthRegion?: () => Promise<OAuthRegion | null>;
  title?: string;
  remoteHost?: boolean;
}>();

const { step, pollError, flow, secondsLeft, autoOpenBlocked, errorMessage, startFlow, cancelFlow } = useOAuthLoginFlow({
  onStartOAuthLogin: props.onStartOAuthLogin,
  onPollOAuthLogin: props.onPollOAuthLogin,
  onCancelOAuthLogin: props.onCancelOAuthLogin,
  onSuccess: () => {
    emit('success');
    emit('close');
  },
  autoOpen: desktopLoginBridge ? createDesktopOAuthAutoOpen(withDesktopLoginSource) : createWebOAuthAutoOpen(),
  authWake: desktopLoginBridge ? createDesktopAuthWake() : createWebAuthWake(),
});

const copied = ref(false);

const phase = ref<'choice' | 'flow'>('choice');

const REGION_CARDS: ReadonlyArray<OAuthLoginCardSpec> = [
  { region: 'mainland-cn', titleKey: 'login.regionCnHint', domain: 'kimi.com' },
  { region: 'global', titleKey: 'login.regionOverseasHint', domain: 'kimi.ai' },
];

const FALLBACK_CARD = { titleKey: 'login.oauthTitle', hintKey: 'login.oauthHint' } as const;

const regionSupport = ref<OAuthRegionSupport>('pending');
const loginCards = computed(() =>
  resolveOAuthLoginCards(regionSupport.value, REGION_CARDS, FALLBACK_CARD),
);

const verificationUriComplete = computed(() =>
  flow.value
    ? desktopLoginBridge
      ? withDesktopLoginSource(flow.value.verificationUriComplete)
      : flow.value.verificationUriComplete
    : '',
);

onMounted(() => {
  void props.onGetOAuthRegion?.().then((region) => {
    regionSupport.value = region === null ? 'unsupported' : 'supported';
  });
});

function startLogin(region?: OAuthRegion): void {
  phase.value = 'flow';
  void startFlow(region);
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

async function close(): Promise<void> {
  cancelFlow();
  emit('close');
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <Dialog v-model:open="open" :size="phase === 'choice' ? 'md' : 'sm'" :title="title ?? t('login.title')" :close-on-overlay="false" @close="close">

    <div v-if="phase === 'choice'" class="nb-cards">
      <ActionCard
        v-for="card in loginCards"
        :key="card.region ?? 'oauth'"
        :disabled="card.disabled"
        @select="startLogin(card.region)"
      >
        <template #leading><BrandLogo :size="40" /></template>
        <i18n-t :keypath="card.titleKey" tag="span">
          <template v-if="card.domain" #domain><span class="nb-domain">{{ card.domain }}</span></template>
        </i18n-t>
        <template v-if="card.hintKey" #hint>{{ t(card.hintKey) }}</template>
      </ActionCard>
    </div>

    <!-- Starting (brief spinner) -->
    <div v-else-if="step === 'starting'" class="center-body">
      <Spinner size="md" />
      <span class="center-text">{{ t('login.starting') }}</span>
    </div>

    <!-- Authorization wait: the verification page auto-opened in the browser
         (one placeholder tab per flow); this dialog just waits for the daemon
         to confirm. -->
    <div v-else-if="step === 'device-code' && flow" class="nb">
      <div class="nb-hero">
        <span class="nb-hero-icon"><BrandLogo :size="48" /></span>
        <div v-if="autoOpenBlocked" class="nb-hero-title">{{ t('login.blockedTitle') }}</div>
        <div class="nb-hero-hint">{{ autoOpenBlocked ? t('login.blockedHint') : t('login.openedHint', { time: formatSeconds(secondsLeft) }) }}</div>
      </div>

      <!-- The automatic open failed (popup blocked / tab closed): surface a
           prominent manual button. -->
      <Button v-if="autoOpenBlocked" variant="primary" @click="reopenVerification">
        {{ t('login.authorizeInBrowser') }}
        <Icon name="external-link" size="sm" />
      </Button>

      <!-- Quiet manual fallback: copy the link via an inline text button. -->
      <div class="nb-manual">
        <span class="nb-manual-label">
          {{ t('login.notOpened') }}
          <Button variant="text" class="nb-copy-text" :class="{ 'is-copied': copied }" @click="copyLink">
            {{ copied ? t('login.copied') : t('login.copyLink') }}
          </Button>
        </span>
      </div>
    </div>

    <!-- Success -->
    <div v-else-if="step === 'success'" class="center-body">
      <AuthStateIcon kind="success" />
      <span class="center-text success-text">{{ t('login.success') }}</span>
      <span class="center-hint">{{ t('login.successHint') }}</span>
    </div>

    <!-- Denied (the user cancelled on the authorization page) -->
    <template v-else-if="step === 'denied'">
      <div class="center-body">
        <AuthStateIcon kind="expired" />
        <span class="center-text err-text">{{ t('login.deniedTitle') }}</span>
        <span class="center-hint">{{ t('login.expiredHint') }}</span>
      </div>
      <div class="actions">
        <Button variant="primary" @click="startFlow()">{{ t('login.retry') }}</Button>
        <Button variant="secondary" @click="close">{{ t('login.closeBtn') }}</Button>
      </div>
    </template>

    <!-- Expired / Cancelled -->
    <template v-else-if="step === 'expired'">
      <div class="center-body">
        <AuthStateIcon kind="expired" />
        <span class="center-text err-text">{{ t('login.expiredTitle') }}</span>
        <span class="center-hint">{{ t('login.expiredHint') }}</span>
      </div>
      <div class="actions">
        <Button variant="primary" @click="startFlow()">{{ t('login.retry') }}</Button>
        <Button variant="secondary" @click="close">{{ t('login.closeBtn') }}</Button>
      </div>
    </template>

    <!-- Error (endpoint missing, network failure, or repeated poll failures) -->
    <template v-else-if="step === 'error'">
      <div class="center-body">
        <AuthStateIcon kind="error" />
        <span class="center-text warn-text">
          {{ pollError ? t('login.pollErrorTitle') : t('login.failedTitle') }}
        </span>
        <span class="center-hint">
          {{ pollError ? t(remoteHost ? 'login.hostPollErrorHint' : 'login.pollErrorHint') : (errorMessage ?? t(remoteHost ? 'login.hostErrorHint' : 'login.errorHint')) }}
        </span>
      </div>
      <div class="actions">
        <Button variant="primary" @click="startFlow()">{{ t('login.retry') }}</Button>
        <Button variant="secondary" @click="close">{{ t('login.closeBtn') }}</Button>
      </div>
    </template>

  </Dialog>
</template>

<style scoped>
.nb-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2) 0 var(--space-4);
}
.nb-domain {
  font-weight: var(--weight-semibold);
}

.center-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) 0 var(--space-4);
  text-align: center;
}
.center-text {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.success-text { color: var(--color-success); }
.err-text { color: var(--color-danger); }
.warn-text { color: var(--color-warning); font-size: var(--text-base); }
.center-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.nb {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) 0 var(--space-4);
}

.nb-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
}
.nb-hero-icon {
  display: inline-flex;
  margin-bottom: var(--space-1);
}
.nb-hero-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.nb-hero-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
  font-variant-numeric: tabular-nums;
}

.nb-manual {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}
.nb-manual-label {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.nb-copy-text { margin-left: var(--space-2); }
.nb-copy-text.is-copied { color: var(--color-success); text-decoration: none; }

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-4);
}

@media (max-width: 640px) {
  .center-body,
  .nb {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .actions {
    flex-wrap: wrap;
  }
}
</style>
