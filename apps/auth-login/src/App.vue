<!-- apps/auth-login/src/App.vue -->
<!-- Remote Control auth interstitial: a single mobile-first page that runs the
     Kimi Code OAuth device flow directly against the OAuth host, then trades
     the token for a server-side session via the relay's exchange endpoint
     (which plants an HttpOnly session cookie — the token never touches
     document.cookie). With `?redirect_uri=` it redirects back after sign-in;
     without one it simply lands on a "signed in" state. Desktop widths get a
     centered card. -->
<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useOAuthLoginFlow } from '@moonshot-ai/app-client/composables';
import { AuthStateIcon, Button, Spinner } from '@moonshot-ai/app-ui';
import { parseRedirectUri } from './helpers';
import { createAuthLoginFlow } from './flow';
import { exchangeSession, probeSession, ExchangeError } from './session';

const { t } = useI18n();

// Per-instance mask id so the logo's eye cutouts can't collide.
const maskId = `bl-eyes-${useId()}`;

// The page's own steps precede the OAuth flow's: an existing server-side
// session short-circuits the flow entirely (redirect when a target is known,
// a plain "signed in" state otherwise); 'entry' explains the RC session and
// waits for the user to kick off the device flow with the login button.
type PageStep = 'checking' | 'entry' | 'signed-in' | 'flow';
const pageStep = ref<PageStep>('checking');
// Optional redirect target. Missing or invalid values both degrade to "no
// redirect" — a malformed param must not strand the user off the sign-in flow.
const redirectUri = ref<string | null>(null);
// Set when the relay rejected the token exchange: the OAuth flow succeeded
// but no session exists, so navigating away would just bounce back here.
// exchangeStatus keeps the failure's HTTP status (null = transient network
// failure): a permanent 4xx won't heal with the same credentials, so the
// retry path branches on it (see retryExchange).
const exchangeFailed = ref(false);
const exchangeStatus = ref<number | null>(null);

// Fired by onToken the instant the poll returns the token — before the state
// machine's success dwell — so the exchange is usually done (and the cookie
// planted) even if the user closes the tab while the success state shows.
let pendingExchange: Promise<void> | null = null;

function runExchange(): void {
  const token = authFlow.authenticatedToken();
  if (!token) {
    exchangeFailed.value = true;
    return;
  }
  pendingExchange = exchangeSession(token);
}

const authFlow = createAuthLoginFlow({ onToken: runExchange });
const { step, pollError, flow, secondsLeft, startFlow } = useOAuthLoginFlow({
  ...authFlow.callbacks,
  onSuccess: finishSignIn,
});

const displayStep = computed(() => {
  if (exchangeFailed.value) return 'exchange-error';
  return pageStep.value === 'flow' ? step.value : pageStep.value;
});

async function finishSignIn(): Promise<void> {
  // The exchange started at onToken; only navigate once the cookie is
  // actually planted, otherwise the target bounces straight back here.
  try {
    await pendingExchange;
  } catch (err) {
    exchangeStatus.value = err instanceof ExchangeError ? err.status : null;
    exchangeFailed.value = true;
    return;
  }
  const target = redirectUri.value;
  if (target) {
    // replace(): the interstitial should not stay in browser history.
    location.replace(target);
  }
}

async function retryExchange(): Promise<void> {
  const status = exchangeStatus.value;
  exchangeFailed.value = false;
  exchangeStatus.value = null;
  // A permanent 4xx rejection (expired / revoked / invalid token) fails the
  // same way every time with the same credentials — restart the device flow
  // for a fresh token. Only transient failures (network, 5xx) re-post.
  if (status !== null && status >= 400 && status < 500) {
    await beginFlow();
    return;
  }
  runExchange();
  await finishSignIn();
}

onMounted(async () => {
  document.title = t('login.title');
  redirectUri.value = parseRedirectUri(location.search);
  // The session cookie is HttpOnly, so the probe endpoint is the only way to
  // detect an existing session. (The relay may still append force_relogin=1
  // to its login redirect; it needs no handling — JS can neither see nor
  // clear the cookie, and the probe is authoritative either way.)
  if (await probeSession()) {
    if (redirectUri.value) {
      location.replace(redirectUri.value);
    } else {
      pageStep.value = 'signed-in';
    }
    return;
  }
  pageStep.value = 'entry';
});

// The login button on the entry step: only a click starts the device flow.
// The verification page auto-opens in a new tab — the placeholder must be
// opened synchronously inside the click (popup blockers demand a gesture),
// then navigated once the flow yields its URL. When the tab can't open
// (blocked), the quiet copy-link line on the waiting page is the fallback.
let authTab: Window | null = null;

async function beginFlow(): Promise<void> {
  authTab = window.open('', '_blank');
  if (authTab) authTab.opener = null;
  pageStep.value = 'flow';
  await startFlow();
}

watch(flow, (f) => {
  if (!f) return;
  const url = f.verificationUriComplete;
  if (authTab && !authTab.closed) {
    authTab.location.href = url;
  } else {
    // Retry paths stay inside a click gesture (the retry buttons call
    // beginFlow too), so a fresh open can still succeed here.
    authTab = window.open(url, '_blank', 'noopener,noreferrer');
  }
});

// A failed start never yields a flow, so the placeholder opened in beginFlow
// would just sit blank — close it instead of littering one tab per retry.
watch(step, (s) => {
  if (s !== 'error' || flow.value) return;
  if (authTab && !authTab.closed) authTab.close();
  authTab = null;
});

const copied = ref(false);

async function copyLink(): Promise<void> {
  if (!flow.value) return;
  const ok = await copyTextToClipboard(flow.value.verificationUriComplete);
  if (!ok) return;
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}

// Format seconds as m:ss
function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <main class="page">
    <div class="panel">
      <header class="brand">
        <!-- Legacy "little blue" brand mark (static rendering of the web
             onboarding BrandLogo, minus the blink easter egg). -->
        <svg
          class="brand-logo"
          viewBox="0 0 32 22"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Kimi Code"
        >
          <defs>
            <mask :id="maskId" maskUnits="userSpaceOnUse">
              <rect x="0" y="0" width="32" height="22" fill="#fff" />
              <g fill="#000">
                <rect x="11.8" y="7" width="2.8" height="8" rx="1.4" />
                <rect x="17.4" y="7" width="2.8" height="8" rx="1.4" />
              </g>
            </mask>
          </defs>
          <rect x="1" y="1" width="30" height="20" rx="6" fill="var(--logo)" :mask="`url(#${maskId})`" />
        </svg>
        <h1 class="title">{{ t('login.title') }}</h1>
        <p class="subtitle">{{ t('login.rcSubtitle') }}</p>
      </header>

      <Transition name="step" mode="out-in">
        <!-- Checking cookie / starting the flow -->
        <div v-if="displayStep === 'checking' || displayStep === 'starting'" key="busy" class="center-body">
          <Spinner size="md" />
          <span class="center-text">{{ displayStep === 'checking' ? t('login.rcChecking') : t('login.starting') }}</span>
        </div>

        <!-- Entry: why sign-in is needed + the login button (a click starts
             the device flow) -->
        <div v-else-if="displayStep === 'entry'" key="entry" class="center-body">
          <p class="lead">{{ t('login.rcLead') }}</p>
          <Button variant="primary" class="entry-btn" @click="beginFlow">{{ t('login.action') }}</Button>
        </div>

        <!-- Device-code step: hero hint (countdown inline) → quiet copy
             fallback. The verification page auto-opened in a new tab (see
             beginFlow); same visual language as the client LoginDialog's
             waiting page. -->
        <div v-else-if="displayStep === 'device-code' && flow" key="device-code" class="flow-body">
          <p class="lead">{{ t('login.openedHint', { time: formatSeconds(secondsLeft) }) }}</p>

          <!-- Quiet fallback: copy the complete link via an inline text button. -->
          <span class="manual-label">
            {{ t('login.notOpened') }}
            <Button variant="text" class="copy-text" :class="{ 'is-copied': copied }" @click="copyLink">
              {{ copied ? t('login.copied') : t('login.copyLink') }}
            </Button>
          </span>
        </div>

        <!-- Success (just authorized) -->
        <div v-else-if="displayStep === 'success'" key="success" class="center-body">
          <AuthStateIcon kind="success" />
          <span class="center-text success-text">{{ t('login.success') }}</span>
          <span class="center-hint">{{ redirectUri ? t('login.rcSuccessHint') : t('login.rcSuccessNoRedirect') }}</span>
        </div>

        <!-- Already signed in (live session, no redirect target) -->
        <div v-else-if="displayStep === 'signed-in'" key="signed-in" class="center-body">
          <AuthStateIcon kind="success" />
          <span class="center-text success-text">{{ t('login.success') }}</span>
          <span class="center-hint">{{ t('login.rcSuccessNoRedirect') }}</span>
        </div>

        <!-- Expired / declined -->
        <div v-else-if="displayStep === 'expired'" key="expired" class="center-body">
          <AuthStateIcon kind="expired" />
          <span class="center-text err-text">{{ t('login.rcExpiredTitle') }}</span>
          <span class="center-hint">{{ t('login.expiredHint') }}</span>
          <Button variant="primary" class="retry-btn" @click="beginFlow">{{ t('login.retry') }}</Button>
        </div>

        <!-- Error (start failure or repeated poll failures) -->
        <div v-else-if="displayStep === 'error'" key="error" class="center-body">
          <AuthStateIcon kind="error" />
          <span class="center-text warn-text">
            {{ pollError ? t('login.pollErrorTitle') : t('login.rcStartErrorTitle') }}
          </span>
          <span class="center-hint">{{ t('login.rcConnectionErrorHint') }}</span>
          <Button variant="primary" class="retry-btn" @click="beginFlow">{{ t('login.retry') }}</Button>
        </div>

        <!-- Exchange failure (OAuth succeeded, the relay rejected the token) -->
        <div v-else-if="displayStep === 'exchange-error'" key="exchange-error" class="center-body">
          <AuthStateIcon kind="error" />
          <span class="center-text warn-text">{{ t('login.rcSessionErrorTitle') }}</span>
          <span class="center-hint">{{ t('login.rcConnectionErrorHint') }}</span>
          <Button variant="primary" class="retry-btn" @click="retryExchange">{{ t('login.retry') }}</Button>
        </div>
      </Transition>
    </div>
  </main>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: calc(var(--space-4) + env(safe-area-inset-top))
    calc(var(--space-4) + env(safe-area-inset-right))
    calc(var(--space-4) + env(safe-area-inset-bottom))
    calc(var(--space-4) + env(safe-area-inset-left));
}

.panel {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

/* Desktop widths: centered quiet card (mobile keeps the flat page). */
@media (min-width: 640px) {
  .panel {
    background: var(--color-surface);
    border: var(--p-hairline) solid var(--color-line);
    border-radius: var(--radius-xl);
    padding: var(--space-8);
  }
}

/* Brand */
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
}
.brand-logo {
  width: 56px;
  height: auto;
  display: block;
}
.title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}
.subtitle {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

/* Centered single-state bodies */
.center-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0 var(--space-2);
  text-align: center;
}
.center-text {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.success-text { color: var(--color-success); }
.err-text { color: var(--color-danger); }
.warn-text { color: var(--color-warning); }
.center-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.retry-btn {
  width: 100%;
  margin-top: var(--space-2);
}
.entry-btn {
  align-self: center;
  padding: 0 var(--space-6);
}

/* Device-code body */
.flow-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.lead {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* Quiet fallback: muted label; the copy action is the Button primitive's
   text variant — only the label spacing and the "copied" state stay here. */
.manual-label {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  text-align: center;
}
.copy-text { margin-left: var(--space-2); }
.copy-text.is-copied { color: var(--color-success); text-decoration: none; }

/* State transitions: short fade + slight rise (reduced-motion friendly). */
.step-enter-active,
.step-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.step-enter-from { opacity: 0; transform: translateY(4px); }
.step-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .step-enter-active,
  .step-leave-active { transition: none; }
}
</style>
