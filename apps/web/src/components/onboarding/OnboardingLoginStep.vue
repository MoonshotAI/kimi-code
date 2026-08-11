<!-- apps/kimi-web/src/components/onboarding/OnboardingLoginStep.vue -->
<!-- Onboarding wizard step 4 — model-service choice. The "Log in with Kimi"
     card starts the embedded device-code flow (useOAuthLoginFlow, shared with
     the standalone LoginDialog); an already-authenticated user sees the done
     state instead. Copy for the flow itself reuses the `login.*` keys. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import {
  useOAuthLoginFlow,
  type OAuthLoginStartResult,
} from '../../composables/useOAuthLoginFlow';
import { AuthStateIcon, Button, Icon, Spinner } from '@moonshot-ai/app-ui';
import BrandLogo from './BrandLogo.vue';

const { t } = useI18n();

const props = defineProps<{
  authReady: boolean;
  onStartOAuthLogin: () => Promise<OAuthLoginStartResult | null>;
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
}>();

const emit = defineEmits<{ success: []; addProvider: [] }>();

// 'choice' → picking a service card; 'flow' → device-code authorization UI.
const phase = ref<'choice' | 'flow'>('choice');

const { step, pollError, flow, secondsLeft, startFlow, cancelFlow } = useOAuthLoginFlow({
  onStartOAuthLogin: props.onStartOAuthLogin,
  onPollOAuthLogin: props.onPollOAuthLogin,
  onCancelOAuthLogin: props.onCancelOAuthLogin,
  onSuccess: () => emit('success'),
});

const copied = ref(false);

function startLogin(): void {
  phase.value = 'flow';
  void startFlow();
}

function backToChoice(): void {
  cancelFlow();
  phase.value = 'choice';
}

// Copies the complete verification URI (device code embedded) — the manual
// code-entry fallback is parked, but the link itself stays available.
async function copyLink(): Promise<void> {
  if (!flow.value) return;
  const ok = await copyTextToClipboard(flow.value.verificationUriComplete);
  if (!ok) return;
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
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
    <button class="ls-card" type="button" @click="startLogin">
      <BrandLogo :size="40" class="ls-card-logo" />
      <div class="ls-card-text">
        <div class="ls-card-title">
          {{ t('onboarding.login.kimiTitle') }}
          <span class="ls-reco">{{ t('onboarding.login.recommended') }}</span>
        </div>
        <div class="ls-card-hint">{{ t('onboarding.login.kimiHint') }}</div>
      </div>
      <Icon name="chevron-right" size="lg" class="ls-card-chevron" />
    </button>
    <!-- Third-party entry: lands on Settings → Providers (the parent completes
         onboarding first, same as skipping the login step). -->
    <button class="ls-card" type="button" @click="emit('addProvider')">
      <span class="ls-card-logo ls-card-icon"><Icon name="bolt" size="lg" /></span>
      <div class="ls-card-text">
        <div class="ls-card-title">{{ t('onboarding.login.customProviderTitle') }}</div>
        <div class="ls-card-hint">{{ t('onboarding.login.customProviderHint') }}</div>
      </div>
      <Icon name="chevron-right" size="lg" class="ls-card-chevron" />
    </button>
  </div>

  <!-- Device-code flow -->
  <div v-else class="ls-flow">
    <!-- Starting (brief spinner) -->
    <div v-if="step === 'starting'" class="ls-center">
      <Spinner size="md" />
      <span class="ls-center-text">{{ t('login.starting') }}</span>
    </div>

    <!-- Device-code step -->
    <div v-else-if="step === 'device-code' && flow" class="ls-device">
      <div class="ls-lead">{{ t('login.lead') }}</div>

      <!-- Primary path: open the complete URI (device code already embedded) -->
      <a
        class="ls-primary"
        :href="flow.verificationUriComplete"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t('login.authorizeInBrowser') }}
        <Icon name="external-link" size="sm" />
      </a>

      <!-- Copyable complete link (device code embedded) for "open it elsewhere"
           — the manual code-entry block below stays parked. -->
      <div class="ls-code-row">
        <span class="ls-link" :title="flow.verificationUriComplete">{{ flow.verificationUriComplete }}</span>
        <Button class="ls-copy" :class="{ 'is-copied': copied }" variant="secondary" size="sm" @click="copyLink">
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

      <div class="ls-status">
        <Spinner size="sm" :label="t('login.waitingAuth')" />
        <span class="ls-status-text">{{ t('login.waitingAutoClose') }}</span>
        <span class="ls-countdown">{{ formatSeconds(secondsLeft) }}</span>
      </div>
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
        <Button variant="primary" @click="startFlow">{{ t('login.retry') }}</Button>
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
        <Button variant="primary" @click="startFlow">{{ t('login.retry') }}</Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Choice cards */
.ls-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.ls-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.ls-card:hover {
  border-color: var(--color-line-strong);
  background: var(--color-surface);
}
.ls-card:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring-strong);
}
.ls-card-logo { align-self: flex-start; }
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
.ls-reco {
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.ls-card-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.ls-card-chevron {
  color: var(--color-text-faint);
  flex: none;
}

/* Logged-in done card */
.ls-done-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-success-bd);
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

/* Device-code body (same visual language as the standalone LoginDialog) */
.ls-device {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.ls-lead {
  font-size: var(--text-base);
  color: var(--color-text);
  line-height: var(--leading-normal);
}
.ls-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 40px;
  padding: 0 var(--space-4);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  border: 0.5px solid var(--color-accent);
  border-radius: var(--radius-md);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  cursor: pointer;
  text-decoration: none;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.ls-primary:hover { background: var(--color-accent-hover); border-color: var(--color-accent-hover); }
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
  border-bottom: 0.5px solid var(--color-accent-bd);
}
.ls-fb-link:hover { border-bottom-color: var(--color-accent); }
.ls-code-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
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
/* Copyable complete verification link (single-line, truncated). */
.ls-link {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.ls-copy.is-copied { color: var(--color-success); border-color: var(--color-success-bd); }
.ls-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 0.5px solid var(--color-line);
}
.ls-status-text {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  flex: 1;
}
.ls-countdown {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.ls-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

@media (max-width: 640px) {
  .ls-code-row,
  .ls-status,
  .ls-actions {
    flex-wrap: wrap;
  }
  .ls-code {
    min-width: 0;
    overflow-wrap: anywhere;
    letter-spacing: 0.08em;
  }
  .ls-status-text { min-width: 0; }
}
</style>
