<!-- apps/kimi-web/src/components/dialogs/LoginDialog.vue -->
<!-- Managed Kimi OAuth device-code login dialog. Built on the design-system -->
<!-- Dialog primitive; the device code + countdown stay monospace. -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Spinner from '../ui/Spinner.vue';
import Icon from '../ui/Icon.vue';
import AuthStateIcon from '../ui/AuthStateIcon.vue';

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
  onStartOAuthLogin: () => Promise<
    | {
        flowId: string;
        provider: string;
        status: 'pending';
        verificationUri: string;
        verificationUriComplete: string;
        userCode: string;
        expiresIn: number;
        interval: number;
        expiresAt: string;
      }
    | {
        flowId: string;
        provider: string;
        status: 'authenticated';
      }
    | null
  >;
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
}>();

// -------------------------------------------------------------------------
// State
// 'starting'     → calling startOAuthLogin (brief spinner)
// 'device-code'  → showing code, polling
// 'success'      → authenticated
// 'expired'      → flow expired or cancelled
// 'error'        → startOAuthLogin failed (endpoint missing)
// -------------------------------------------------------------------------

type Step = 'starting' | 'device-code' | 'success' | 'expired' | 'error';
const step = ref<Step>('starting');
// True when the error step came from repeated poll failures (daemon gone)
// rather than startOAuthLogin failing (unsupported endpoint) — picks the copy.
const pollError = ref(false);

interface FlowData {
  flowId: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

const flow = ref<FlowData | null>(null);
const secondsLeft = ref(0);
const copied = ref(false);

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
// Consecutive failed polls (onPollOAuthLogin returned null). A single null can
// be a transient blip; several in a row means the daemon is gone and polling
// forever would strand the user on "waiting for authorization".
let consecutivePollFailures = 0;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------

onMounted(async () => {
  await startFlow();
});

onUnmounted(() => {
  stopTimers();
});

// -------------------------------------------------------------------------
// Flow control
// -------------------------------------------------------------------------

async function startFlow(): Promise<void> {
  stopTimers();
  flow.value = null;
  pollError.value = false;
  consecutivePollFailures = 0;
  step.value = 'starting';

  const result = await props.onStartOAuthLogin();
  if (!result) {
    step.value = 'error';
    return;
  }

  // Already-authenticated fast path: the server had a usable cached token and
  // did not issue a device code. Skip the device-code UI entirely and surface
  // the success state — the poller is irrelevant here.
  if (result.status === 'authenticated') {
    stopTimers();
    step.value = 'success';
    setTimeout(() => {
      emit('success');
      emit('close');
    }, 800);
    return;
  }

  flow.value = {
    flowId: result.flowId,
    verificationUri: result.verificationUri,
    verificationUriComplete: result.verificationUriComplete,
    userCode: result.userCode,
    expiresIn: result.expiresIn,
    interval: result.interval,
  };
  secondsLeft.value = result.expiresIn;
  step.value = 'device-code';
  startCountdown();
  scheduleNextPoll(result.interval);
}

function startCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (secondsLeft.value > 0) {
      secondsLeft.value--;
    } else {
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);
}

function scheduleNextPoll(intervalSec: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const result = await props.onPollOAuthLogin();
    if (result === null) {
      // Poll failed (or no active flow). Keep polling through transient
      // blips, but give up with an explicit error after several in a row.
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        stopTimers();
        pollError.value = true;
        step.value = 'error';
        return;
      }
      scheduleNextPoll(intervalSec);
      return;
    }
    consecutivePollFailures = 0;
    if (result.status === 'authenticated') {
      stopTimers();
      step.value = 'success';
      setTimeout(() => {
        emit('success');
        emit('close');
      }, 1200);
    } else if (result.status === 'expired' || result.status === 'cancelled') {
      stopTimers();
      step.value = 'expired';
    } else {
      // pending — keep polling
      scheduleNextPoll(intervalSec);
    }
  }, intervalSec * 1000);
}

function stopTimers(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

async function retryFlow(): Promise<void> {
  await startFlow();
}

async function copyCode(): Promise<void> {
  if (!flow.value) return;
  const ok = await copyTextToClipboard(flow.value.userCode);
  if (!ok) return;
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

async function close(): Promise<void> {
  stopTimers();
  // Best-effort cancel
  if (step.value === 'device-code') {
    void props.onCancelOAuthLogin();
  }
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
  <Dialog v-model:open="open" :title="t('login.title')" :close-on-overlay="false" @close="close">

    <!-- Starting (brief spinner) -->
    <div v-if="step === 'starting'" class="center-body">
      <Spinner size="md" />
      <span class="center-text">{{ t('login.starting') }}</span>
    </div>

    <!-- Device-code step -->
    <div v-else-if="step === 'device-code' && flow" class="nb">
      <div class="nb-lead">{{ t('login.lead') }}</div>

      <!-- Primary path: open the complete URI (device code already embedded) -->
      <a
        class="nb-primary"
        :href="flow.verificationUriComplete"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t('login.authorizeInBrowser') }}
        <Icon name="external-link" size="sm" />
      </a>

      <!-- Divider -->
      <div class="nb-or">{{ t('login.orDivider') }}</div>

      <!-- Fallback path: open the plain URI and type the code manually -->
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

      <!-- Status -->
      <div class="nb-status">
        <Spinner size="sm" :label="t('login.waitingAuth')" />
        <span class="nb-status-text">{{ t('login.waitingAutoClose') }}</span>
        <span class="nb-countdown">{{ formatSeconds(secondsLeft) }}</span>
      </div>
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
        <Button variant="primary" @click="retryFlow">{{ t('login.retry') }}</Button>
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
        <Button variant="primary" @click="retryFlow">{{ t('login.retry') }}</Button>
        <Button variant="secondary" @click="close">{{ t('login.closeBtn') }}</Button>
      </div>
    </template>

  </Dialog>
</template>

<style scoped>
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

/* Device-code body */
.nb {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) 0 var(--space-4);
}
.nb-lead {
  font-size: var(--text-base);
  color: var(--color-text);
  line-height: var(--leading-normal);
}

/* Primary path: open the complete URI (device code embedded).
   Kept as an anchor (it opens a URL in a new tab) and styled to match the
   primary Button — converting it to <Button> would drop the href/target. */
.nb-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 40px;
  padding: 0 var(--space-4);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  cursor: pointer;
  text-decoration: none;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.nb-primary:hover { background: var(--color-accent-hover); border-color: var(--color-accent-hover); }

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
  border-bottom: 1px solid var(--color-accent-bd);
}
.nb-fb-link:hover { border-bottom-color: var(--color-accent); }
.nb-code-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
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

/* Status */
.nb-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
}
.nb-status-text { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-text-muted); flex: 1; }
.nb-countdown {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* Actions */
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
  .nb-code-row,
  .nb-status,
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
  .nb-primary {
    min-height: 44px;
  }
  .nb-status-text {
    min-width: 0;
  }
}
</style>
