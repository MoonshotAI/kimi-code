<!-- apps/web/src/components/dialogs/LoginDialog.vue -->
<!-- Managed Kimi OAuth device-code login dialog. Opens on a login-entry
     choice (one ActionCard per OAuth endpoint), then runs the device-code
     flow for the picked entry — the verification page auto-opens in the
     browser while the dialog waits (useOAuthLoginFlow's autoOpen driver).
     Built on the design-system Dialog primitive; the link + countdown stay
     monospace. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard, resolveOAuthLoginCards } from '@moonshot-ai/app-core/lib';
import type { OAuthRegionSupport } from '@moonshot-ai/app-core/lib';
import {
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
import { ActionCard, AuthStateIcon, Button, Dialog, Icon, Spinner } from '@moonshot-ai/app-ui';
import BrandLogo from '../onboarding/BrandLogo.vue';

const { t } = useI18n();

// The parent controls visibility with `v-if`, so the dialog is open whenever
// this component is mounted. Dialog owns focus, Esc-to-close, and the close
// button; we forward its `close` event through our `close()` so the OAuth
// flow is cancelled and timers are stopped before the parent unmounts us.
const open = ref(true);

// -------------------------------------------------------------------------
// Emits
// -------------------------------------------------------------------------

const emit = defineEmits<{
  success: [];
  close: [];
}>();

// -------------------------------------------------------------------------
// Props: injected callbacks
// -------------------------------------------------------------------------

const props = defineProps<{
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

// -------------------------------------------------------------------------
// Flow state machine (shared with the onboarding wizard's login step)
// -------------------------------------------------------------------------

const { step, pollError, flow, secondsLeft, autoOpenBlocked, startFlow, cancelFlow } = useOAuthLoginFlow({
  onStartOAuthLogin: props.onStartOAuthLogin,
  onPollOAuthLogin: props.onPollOAuthLogin,
  onCancelOAuthLogin: props.onCancelOAuthLogin,
  onSuccess: () => {
    emit('success');
    emit('close');
  },
  autoOpen: createDesktopOAuthAutoOpen(withDesktopLoginSource),
  authWake: createDesktopAuthWake(),
});

const copied = ref(false);

// 'choice' → picking a region card; 'flow' → device-code authorization UI.
const phase = ref<'choice' | 'flow'>('choice');

// One card per OAuth host region; the mainland-cn card leads unless the server
// suggests global.
const REGION_CARDS: ReadonlyArray<{ region: OAuthRegion; titleKey: string; hintKey: string }> = [
  { region: 'mainland-cn', titleKey: 'login.regionCnTitle', hintKey: 'login.regionCnHint' },
  { region: 'global', titleKey: 'login.regionOverseasTitle', hintKey: 'login.regionOverseasHint' },
];

// Older daemon without region support (the probe answers null): one neutral
// card starts the flow with no region — the pre-region behavior.
const FALLBACK_CARD = { titleKey: 'login.oauthTitle', hintKey: 'login.oauthHint' } as const;

// The probe is a loopback round-trip; until it lands, show the region cards
// (the common case is a region-aware daemon), so nothing visibly swaps.
const regionSupport = ref<OAuthRegionSupport>('pending');
const loginCards = computed(() =>
  resolveOAuthLoginCards(regionSupport.value, REGION_CARDS, FALLBACK_CARD),
);

// Desktop divergence: the verification URL shown / opened / copied from this
// dialog carries `from=kimi_code_desktop` so the auth page renders the "open
// the desktop app" button only for desktop-originated flows.
const verificationUriComplete = computed(() =>
  flow.value ? withDesktopLoginSource(flow.value.verificationUriComplete) : '',
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

async function close(): Promise<void> {
  cancelFlow();
  emit('close');
}

// Format seconds as mm:ss
function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <Dialog v-model:open="open" :size="phase === 'choice' ? 'md' : 'sm'" :title="t('login.title')" :close-on-overlay="false" @close="close">

    <!-- Region choice: one card per OAuth host region — or a single neutral
         card when the daemon predates region support. -->
    <div v-if="phase === 'choice'" class="nb-cards">
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

      <!-- TODO: the manual fallback (copy the link + type the device code) has
           a bug and is parked for now. Restore together with the commented-out
           copyCode in the script.

      <div class="nb-or">{{ t('login.orDivider') }}</div>

      <div class="nb-fallback">
        <div class="nb-fb-text">
          {{ t('login.fallbackPrefix') }}<a
            class="nb-fb-link"
            :href="flow.verificationUri"
            target="_blank"
            rel="noopener noreferrer"
          >{{ flow.verificationUri }}</a>{{ t('login.fallbackSuffix') }}
        </div>
        <div class="nb-code-row">
          <span class="nb-code">{{ flow.userCode }}</span>
          <Button class="nb-copy" :class="{ 'is-copied': copied }" variant="secondary" size="sm" @click="copyCode">
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
      </div>
      -->
    </div>

    <!-- Success -->
    <div v-else-if="step === 'success'" class="center-body">
      <AuthStateIcon kind="success" />
      <span class="center-text success-text">{{ t('login.success') }}</span>
      <span class="center-hint">{{ t('login.successHint') }}</span>
    </div>

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
          {{ pollError ? t('login.pollErrorTitle') : t('login.errorTitle') }}
        </span>
        <span class="center-hint">
          {{ pollError ? t('login.pollErrorHint') : t('login.errorHint') }}
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
/* Login-entry choice cards (the ActionCard primitive carries the chrome;
   same visual language as the onboarding login step) */
.nb-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2) 0 var(--space-4);
}

/* Centered single-state bodies */
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

/* Device-code body: the authorization wait page */
.nb {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) 0 var(--space-4);
}

/* Hero: soft accent badge over the centered title + hint */
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

/* Quiet manual fallback: muted label with an inline text button */
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
/* The copy action is the Button primitive's text variant; only the label
   spacing and the "copied" state stay here. */
.nb-copy-text { margin-left: var(--space-2); }
.nb-copy-text.is-copied { color: var(--color-success); text-decoration: none; }

/* "or" divider */
.nb-or {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  letter-spacing: 0.06em;
}
.nb-or::before,
.nb-or::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--color-line);
}

/* Fallback path: open plain URI, type the code */
.nb-fallback {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.nb-fb-text {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.nb-fb-link {
  color: var(--color-accent);
  text-decoration: none;
  border-bottom: var(--p-hairline) solid var(--color-accent-bd);
}
.nb-fb-link:hover { border-bottom-color: var(--color-accent); }
.nb-code-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-surface-sunken);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
}
.nb-code {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--text-xl);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  letter-spacing: 0.14em;
}
/* Inline copy control: Button secondary + a success "copied" state. */
.nb-copy.is-copied { color: var(--color-success); border-color: var(--color-success-bd); }

/* Actions */
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-4);
}

/* var() is not allowed in @media — 640px mirrors the --p-bp-sm token. */
@media (max-width: 640px) {
  .center-body,
  .nb {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .nb-code-row,
  .actions {
    flex-wrap: wrap;
  }
  .nb-code {
    min-width: 0;
    overflow-wrap: anywhere;
    letter-spacing: 0.08em;
  }
  .nb-copy {
    min-height: 34px;
  }
}
</style>
