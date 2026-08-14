<!-- apps/auth-login/src/App.vue -->
<!-- Remote Control auth interstitial: a single mobile-first page that runs the
     Kimi Code OAuth device flow directly against the OAuth host and stores the
     access token in the `kimi-auth` cookie. With `?redirect_uri=` (the tunnel
     entry case) it redirects back after sign-in; without one it simply lands
     on a "signed in" state. `?force_relogin=1` drops any existing cookie and
     starts over (the tunnel uses it after rejecting a token). Desktop widths
     get a centered card. -->
<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useOAuthLoginFlow } from '@moonshot-ai/app-client/composables';
import { AuthStateIcon, Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import {
  buildTokenCookie,
  clearTokenCookie,
  parseRedirectUri,
  readTokenCookie,
} from './auth-token';
import { createAuthLoginFlow } from './flow';

const { t } = useI18n();

// Per-instance mask id so the logo's eye cutouts can't collide.
const maskId = `bl-eyes-${useId()}`;

// The page's own steps precede the OAuth flow's: an existing token cookie
// short-circuits the flow entirely (redirect when a target is known, a plain
// "signed in" state otherwise).
type PageStep = 'checking' | 'signed-in' | 'flow';
const pageStep = ref<PageStep>('checking');
// Optional redirect target. Missing or invalid values both degrade to "no
// redirect" — a malformed param must not strand the user off the sign-in flow.
const redirectUri = ref<string | null>(null);

function writeTokenCookie(accessToken: string, expiresAt: number): void {
  document.cookie = buildTokenCookie(accessToken, {
    expiresAt,
    secure: location.protocol === 'https:',
  });
}

const authFlow = createAuthLoginFlow({
  // Persist the cookie the instant the token arrives — the success state (and
  // its "you can close" hint) shows during the state machine's dwell, so
  // waiting for onSuccess would let an early tab-close lose the sign-in.
  onToken: (token) => writeTokenCookie(token.accessToken, token.expiresAt),
});
const { step, pollError, flow, secondsLeft, startFlow } = useOAuthLoginFlow({
  ...authFlow.callbacks,
  onSuccess: finishSignIn,
});

const displayStep = computed(() => (pageStep.value === 'flow' ? step.value : pageStep.value));

function finishSignIn(): void {
  // The cookie is already persisted (onToken); here we only navigate.
  const target = redirectUri.value;
  if (target) {
    // replace(): the interstitial should not stay in browser history.
    location.replace(target);
  }
}

onMounted(async () => {
  document.title = t('login.title');
  redirectUri.value = parseRedirectUri(location.search);
  // The tunnel bounces users back with force_relogin=1 when the presented
  // cookie was rejected (revoked, wrong environment): drop it and start over
  // instead of ping-ponging between this page and the target.
  const forceRelogin = new URLSearchParams(location.search).get('force_relogin') === '1';
  if (forceRelogin) {
    document.cookie = clearTokenCookie();
  } else if (readTokenCookie(document.cookie)) {
    // A readable cookie is unexpired by definition (Expires handles eviction),
    // so its presence means "already signed in".
    if (redirectUri.value) {
      location.replace(redirectUri.value);
    } else {
      pageStep.value = 'signed-in';
    }
    return;
  }
  pageStep.value = 'flow';
  await startFlow();
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

        <!-- Device-code step -->
        <div v-else-if="displayStep === 'device-code' && flow" key="device-code" class="flow-body">
          <p class="lead">{{ t('login.rcLead') }}</p>

          <!-- Primary path: open the complete URI (device code embedded). An
               anchor, not a Button — it must keep href/target (same pattern as
               the client's LoginDialog). -->
          <a
            class="primary-link"
            :href="flow.verificationUriComplete"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t('login.rcAuthorize') }}
            <Icon name="external-link" size="sm" />
          </a>

          <!-- Verification code + copyable link for the "open it elsewhere"
               path -->
          <div class="code-row">
            <div class="code-meta">
              <span class="code-label">{{ t('login.rcUserCodeLabel') }}</span>
              <span class="code">{{ flow.userCode }}</span>
            </div>
            <Button class="copy-btn" :class="{ 'is-copied': copied }" variant="secondary" size="sm" @click="copyLink">
              <template v-if="copied">
                <Icon name="check" size="sm" />
                {{ t('login.copied') }}
              </template>
              <template v-else>
                <Icon name="copy" size="sm" />
                {{ t('login.copyLink') }}
              </template>
            </Button>
          </div>

          <!-- Status -->
          <div class="status">
            <Spinner size="sm" :label="t('login.waitingAuth')" />
            <span class="status-text">{{ t('login.waitingAutoClose') }}</span>
            <span class="countdown">{{ formatSeconds(secondsLeft) }}</span>
          </div>
        </div>

        <!-- Success (just authorized) -->
        <div v-else-if="displayStep === 'success'" key="success" class="center-body">
          <AuthStateIcon kind="success" />
          <span class="center-text success-text">{{ t('login.success') }}</span>
          <span class="center-hint">{{ redirectUri ? t('login.rcSuccessHint') : t('login.rcSuccessNoRedirect') }}</span>
        </div>

        <!-- Already signed in (valid cookie, no redirect target) -->
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
          <Button variant="primary" class="retry-btn" @click="startFlow">{{ t('login.retry') }}</Button>
        </div>

        <!-- Error (start failure or repeated poll failures) -->
        <div v-else-if="displayStep === 'error'" key="error" class="center-body">
          <AuthStateIcon kind="error" />
          <span class="center-text warn-text">
            {{ pollError ? t('login.pollErrorTitle') : t('login.rcStartErrorTitle') }}
          </span>
          <span class="center-hint">{{ t('login.rcConnectionErrorHint') }}</span>
          <Button variant="primary" class="retry-btn" @click="startFlow">{{ t('login.retry') }}</Button>
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
}

/* Primary action: open the complete verification URI. */
.primary-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--touch-target-min);
  padding: 0 var(--space-4);
  box-sizing: border-box;
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  border: var(--p-hairline) solid var(--color-accent);
  border-radius: var(--radius-md);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  cursor: pointer;
  text-decoration: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
/* Hover only where hover exists (touch taps would flash it). */
@media (hover: hover) and (pointer: fine) {
  .primary-link:hover { background: var(--color-accent-hover); border-color: var(--color-accent-hover); }
}
.primary-link:active { transform: scale(0.98); }
.primary-link:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

/* Code + copy row */
.code-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-surface-sunken);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
.code-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.code-label {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.code {
  font-family: var(--font-mono);
  font-size: var(--text-xl);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  letter-spacing: 0.14em;
  user-select: text;
}
.copy-btn { flex: none; }
.copy-btn.is-copied { color: var(--color-success); border-color: var(--color-success-bd); }

/* Mobile: the copy action drops to a full-width second row under the code. */
@media (max-width: 639px) {
  .code-row {
    flex-direction: column;
    align-items: stretch;
  }
  .copy-btn {
    min-height: 34px;
  }
}

/* Status */
.status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--p-hairline) solid var(--color-line);
}
.status-text {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.countdown {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

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
