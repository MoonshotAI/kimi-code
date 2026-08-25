<!-- Onboarding wizard step 4 — model-service choice. The two OAuth login
     entries start the embedded device-code flow against the matching OAuth
     endpoint (useOAuthLoginFlow, shared with the standalone LoginDialog); an
     already-authenticated user sees the done state instead.
     Copy for the flow itself reuses the `login.*` keys. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard, resolveOAuthLoginCards } from '@moonshot-ai/app-core/lib';
import type { OAuthRegionSupport } from '@moonshot-ai/app-core/lib';
import {
  useIsMobile,
  useOAuthLoginFlow,
  type OAuthLoginStartResult,
  type OAuthRegion,
} from '@moonshot-ai/app-client/composables';
// Desktop divergence (not synced to apps/web): marks the verification URL as
// desktop-originated so the auth page can offer "open the desktop app".
import { withDesktopLoginSource } from '../../lib/loginSource';
// Desktop divergence (driver choice; both driver sets live in app-client's
// lib): auto-open goes through the preload bridge's `openExternal`, and the
// auth wake listens to the main process's deep-link IPC plus window focus;
// web uses the placeholder-tab / focus+visibility factories.
import { createDesktopAuthWake, createDesktopOAuthAutoOpen, isHttpUrl } from '@moonshot-ai/app-client/lib';
import { ActionCard, AuthStateIcon, Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import BrandLogo from './BrandLogo.vue';

const { t } = useI18n();
const isMobile = useIsMobile();

const props = defineProps<{
  authReady: boolean;
  onStartOAuthLogin: (region?: OAuthRegion) => Promise<OAuthLoginStartResult | null>;
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
  /** Region probe in one: the result doubles as the daemon's region-support
      gate (null = a pre-region daemon → one neutral card). */
  onGetOAuthRegion?: () => Promise<OAuthRegion | null>;
}>();

const emit = defineEmits<{ success: []; addProvider: [] }>();

// 'choice' → picking a service card; 'flow' → device-code authorization UI.
const phase = ref<'choice' | 'flow'>('choice');

const { step, pollError, flow, secondsLeft, autoOpenBlocked, startFlow, cancelFlow } = useOAuthLoginFlow({
  onStartOAuthLogin: props.onStartOAuthLogin,
  onPollOAuthLogin: props.onPollOAuthLogin,
  onCancelOAuthLogin: props.onCancelOAuthLogin,
  onSuccess: () => emit('success'),
  autoOpen: createDesktopOAuthAutoOpen(withDesktopLoginSource),
  authWake: createDesktopAuthWake(),
});

const copied = ref(false);

// One card per OAuth endpoint, in the declared order.
const REGION_CARDS: ReadonlyArray<{ region: OAuthRegion; titleKey: string; hintKey: string }> = [
  { region: 'mainland-cn', titleKey: 'onboarding.login.kimiCnTitle', hintKey: 'onboarding.login.kimiCnHint' },
  { region: 'global', titleKey: 'onboarding.login.kimiOverseasTitle', hintKey: 'onboarding.login.kimiOverseasHint' },
];

// Older daemon without region support (the probe answers null): one neutral
// card starts the flow with no region — the pre-region behavior.
const FALLBACK_CARD = { titleKey: 'onboarding.login.kimiTitle', hintKey: 'onboarding.login.kimiHint' } as const;

// The probe is a loopback round-trip; until it lands, show the region cards
// (the common case is a region-aware daemon), so nothing visibly swaps.
const regionSupport = ref<OAuthRegionSupport>('pending');
const loginCards = computed(() =>
  resolveOAuthLoginCards(regionSupport.value, REGION_CARDS, FALLBACK_CARD),
);

onMounted(() => {
  void props.onGetOAuthRegion?.().then((region) => {
    regionSupport.value = region === null ? 'unsupported' : 'supported';
  });
});

// Desktop divergence: the verification URL shown / opened / copied from this
// step carries `from=kimi_code_desktop` so the auth page renders the "open
// the desktop app" button only for desktop-originated flows.
const verificationUriComplete = computed(() =>
  flow.value ? withDesktopLoginSource(flow.value.verificationUriComplete) : '',
);

function startLogin(region?: OAuthRegion): void {
  phase.value = 'flow';
  void startFlow(region);
}

function backToChoice(): void {
  cancelFlow();
  phase.value = 'choice';
}

// Copies the complete verification URI (device code embedded) — the manual
// code-entry fallback is parked, but the link itself stays available.
async function copyLink(): Promise<void> {
  if (!flow.value) return;
  const ok = await copyTextToClipboard(verificationUriComplete.value);
  if (!ok) return;
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

// Manual (re)open from the waiting page — always inside a click gesture, so
// the browser allows it (desktop routes it to the system browser via the
// external-link guard).
function reopenVerification(): void {
  // The URL comes from the daemon over the wire — never hand a non-http(s)
  // payload to the browser (the auto-open driver applies the same rule).
  if (!isHttpUrl(verificationUriComplete.value)) return;
  window.open(verificationUriComplete.value, '_blank', 'noopener,noreferrer');
}

// TODO: parked with the manual device-code fallback (copy link + type the
// code) — it has a bug; restore together with the template block below.
// async function copyCode(): Promise<void> {
//   if (!flow.value) return;
//   const ok = await copyTextToClipboard(flow.value.userCode);
//   if (!ok) return;
//   copied.value = true;
//   setTimeout(() => { copied.value = false; }, 2000);
// }

// Format seconds as mm:ss
function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <!-- Already authenticated: done state, nothing to start. -->
  <div v-if="authReady" class="ls-done-card">
    <span class="ls-done-badge"><Icon name="check" size="sm" /></span>
    <div class="ls-card-text">
      <div class="ls-card-title">{{ t('onboarding.login.loggedInTitle') }}</div>
      <div class="ls-card-hint">{{ t('onboarding.login.loggedInHint') }}</div>
    </div>
  </div>

  <!-- Service choice -->
  <div v-else-if="phase === 'choice'" class="ls-cards">
    <!-- One ActionCard per OAuth endpoint — or a single neutral card when the
         daemon predates endpoint support. Cards are disabled while the
         support probe is in flight. -->
    <ActionCard
      v-for="card in loginCards"
      :key="card.region ?? 'oauth'"
      :disabled="card.disabled"
      @select="startLogin(card.region)"
    >
      <template #leading><BrandLogo :size="40" /></template>
      {{ t(card.titleKey) }}
      <template #hint>{{ t(card.hintKey) }}</template>
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

      <!-- TODO: the manual fallback (copy the link + type the device code) has
           a bug and is parked for now. Restore together with the commented-out
           copyCode in the script.

      <div class="ls-or">{{ t('login.orDivider') }}</div>

      <div class="ls-fb-text">
        {{ t('login.fallbackPrefix') }}<a
          class="ls-fb-link"
          :href="flow.verificationUri"
          target="_blank"
          rel="noopener noreferrer"
        >{{ flow.verificationUri }}</a>{{ t('login.fallbackSuffix') }}
      </div>
      <div class="ls-code-row">
        <span class="ls-code">{{ flow.userCode }}</span>
        <Button class="ls-copy" :class="{ 'is-copied': copied }" variant="secondary" size="sm" @click="copyCode">
          <template v-if="copied">
            <Icon name="check" size="sm" />
            {{ t('login.copied') }}
          </template>
          <template v-else>
            <Icon name="copy" size="sm" />
            {{ t('login.copy') }}
          </template>
        </Button>
      </div>
      -->
    </div>

    <!-- Success -->
    <div v-else-if="step === 'success'" class="ls-center">
      <AuthStateIcon kind="success" />
      <span class="ls-center-text ls-success-text">{{ t('login.success') }}</span>
      <span class="ls-center-hint">{{ t('login.successHint') }}</span>
    </div>

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
          {{ pollError ? t('login.pollErrorTitle') : t('login.errorTitle') }}
        </span>
        <span class="ls-center-hint">
          {{ pollError ? t('login.pollErrorHint') : t('login.errorHint') }}
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
/* Choice cards: the ActionCard primitive carries the chrome; only the
   layout stack and content-specific pieces stay here. */
.ls-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
/* Icon stand-in matching the 40px brand-logo slot on the Kimi card. */
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

/* Logged-in done card */
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

/* Flow states */
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

/* Device-code body: the authorization wait page (same visual language as the
   standalone LoginDialog) */
.ls-device {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Hero: soft accent badge over the centered title + hint */
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

/* Quiet manual fallback: muted label with an inline text button */
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
/* The copy action is the Button primitive's text variant; only the label
   spacing and the "copied" state stay here. */
.ls-copy-text { margin-left: var(--space-2); }
.ls-copy-text.is-copied { color: var(--color-success); text-decoration: none; }
.ls-or {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  letter-spacing: 0.06em;
}
.ls-or::before,
.ls-or::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--color-line);
}
.ls-fb-text {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.ls-fb-link {
  color: var(--color-accent);
  text-decoration: none;
  border-bottom: var(--p-hairline) solid var(--color-accent-bd);
}
.ls-fb-link:hover { border-bottom-color: var(--color-accent); }
.ls-code-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-surface-sunken);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
}
.ls-code {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--text-xl);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  letter-spacing: 0.14em;
}
/* Inline copy control: Button secondary + a success "copied" state. */
.ls-copy.is-copied { color: var(--color-success); border-color: var(--color-success-bd); }
.ls-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

/* var() is not allowed in @media — 640px mirrors the --p-bp-sm token. */
@media (max-width: 640px) {
  .ls-code-row,
  .ls-actions {
    flex-wrap: wrap;
  }
  .ls-code {
    min-width: 0;
    overflow-wrap: anywhere;
    letter-spacing: 0.08em;
  }
}
</style>
