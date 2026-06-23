<!-- apps/kimi-web/src/components/dialogs/LoginDialog.vue -->
<!-- Managed Kimi OAuth device-code login dialog. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDialogFocus } from '../../composables/useDialogFocus';
import { copyTextToClipboard } from '../../lib/clipboard';

const { t } = useI18n();

const dialogRef = ref<HTMLElement | null>(null);
// Move focus into the dialog on open; restore it to the opener on close.
useDialogFocus(dialogRef);

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
  onStartOAuthLogin: () => Promise<{
    flowId: string;
    provider: string;
    verificationUri: string;
    verificationUriComplete: string;
    userCode: string;
    expiresIn: number;
    interval: number;
    status: 'pending';
    expiresAt: string;
  } | null>;
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

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown);
  await startFlow();
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  stopTimers();
});

// -------------------------------------------------------------------------
// Flow control
// -------------------------------------------------------------------------

async function startFlow(): Promise<void> {
  stopTimers();
  flow.value = null;
  step.value = 'starting';

  const result = await props.onStartOAuthLogin();
  if (!result) {
    step.value = 'error';
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
    if (result?.status === 'authenticated') {
      stopTimers();
      step.value = 'success';
      setTimeout(() => {
        emit('success');
        emit('close');
      }, 1200);
    } else if (result?.status === 'expired' || result?.status === 'cancelled') {
      stopTimers();
      step.value = 'expired';
    } else {
      // pending or null — keep polling
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

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void close();
}

// Format seconds as mm:ss
function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <div class="backdrop">
    <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-label="t('login.title')">

      <!-- Header -->
      <div class="dh">
        <span class="dtitle">{{ t('login.title') }}</span>
        <button class="close-btn" :title="t('login.close')" @click="close">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <!-- Starting (brief spinner) -->
      <template v-if="step === 'starting'">
        <div class="center-body">
          <svg class="spin-icon" width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="var(--blue)" stroke-width="1.5">
            <circle cx="11" cy="11" r="8" stroke-dasharray="30 18" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 11 11" to="360 11 11" dur="0.9s" repeatCount="indefinite"/>
            </circle>
          </svg>
          <span class="center-text">{{ t('login.starting') }}</span>
        </div>
      </template>

      <!-- Device-code step -->
      <template v-else-if="step === 'device-code' && flow">
        <div class="nb">
          <div class="nb-lead">{{ t('login.lead') }}</div>

          <!-- Primary path: open the complete URI (device code already embedded) -->
          <a
            class="nb-primary"
            :href="flow.verificationUriComplete"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t('login.authorizeInBrowser') }}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M6 2H2.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8"/>
              <path d="M9.5 1.5h3v3M12.5 1.5 7 7"/>
            </svg>
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
              <button class="nb-copy" :class="{ 'is-copied': copied }" @click="copyCode">
                <template v-if="copied">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="1,6 4,9 11,2"/>
                  </svg>
                  {{ t('login.copied') }}
                </template>
                <template v-else>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="4" y="4" width="7" height="7" rx="1"/>
                    <path d="M8 4V2a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2"/>
                  </svg>
                  {{ t('login.copy') }}
                </template>
              </button>
            </div>
          </div>

          <!-- Status -->
          <div class="nb-status">
            <span class="nb-spinner" :aria-label="t('login.waitingAuth')">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--blue)" stroke-width="1.5">
                <circle cx="7" cy="7" r="5" stroke-dasharray="20 12" stroke-linecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="1s" repeatCount="indefinite"/>
                </circle>
              </svg>
            </span>
            <span class="nb-status-text">{{ t('login.waitingAutoClose') }}</span>
            <span class="nb-countdown">{{ formatSeconds(secondsLeft) }}</span>
          </div>
        </div>
      </template>

      <!-- Success -->
      <template v-else-if="step === 'success'">
        <div class="center-body">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="var(--ok)" stroke-width="2">
            <circle cx="18" cy="18" r="15"/>
            <polyline points="10,18 15,24 26,12"/>
          </svg>
          <span class="center-text success-text">{{ t('login.success') }}</span>
          <span class="center-hint">{{ t('login.successHint') }}</span>
        </div>
      </template>

      <!-- Expired / Cancelled -->
      <template v-else-if="step === 'expired'">
        <div class="center-body">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--err)" stroke-width="1.5">
            <circle cx="14" cy="14" r="12"/>
            <line x1="14" y1="8" x2="14" y2="15"/>
            <circle cx="14" cy="19" r="1.2" fill="var(--err)"/>
          </svg>
          <span class="center-text err-text">{{ t('login.expiredTitle') }}</span>
          <span class="center-hint">{{ t('login.expiredHint') }}</span>
        </div>
        <div class="actions">
          <button class="act-btn primary" @click="retryFlow">{{ t('login.retry') }}</button>
          <button class="act-btn" @click="close">{{ t('login.closeBtn') }}</button>
        </div>
      </template>

      <!-- Error (endpoint missing or network failure) -->
      <template v-else-if="step === 'error'">
        <div class="center-body">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--warn)" stroke-width="1.5">
            <path d="M14 3 L26 24 H2 Z"/>
            <line x1="14" y1="12" x2="14" y2="18"/>
            <circle cx="14" cy="21.5" r="1" fill="var(--warn)"/>
          </svg>
          <span class="center-text warn-text">{{ t('login.errorTitle') }}</span>
          <span class="center-hint">{{ t('login.errorHint') }}</span>
        </div>
        <div class="actions">
          <button class="act-btn primary" @click="retryFlow">{{ t('login.retry') }}</button>
          <button class="act-btn" @click="close">{{ t('login.closeBtn') }}</button>
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 23, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.dialog {
  position: relative;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  width: 480px;
  max-width: calc(100vw - 32px);
  height: 420px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
  overflow: hidden;
}

/* Header */
.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.dtitle {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 700;
  color: var(--ink);
  flex: 1;
  letter-spacing: 0.02em;
}
.close-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.close-btn:hover { color: var(--ink); }

/* Centered single-state bodies */
.center-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 20px 24px;
  text-align: center;
}
.spin-icon { display: block; }
.center-text {
  font-size: var(--ui-font-size-sm);
  font-weight: 600;
  color: var(--ink);
}
.success-text { color: var(--ok); }
.err-text { color: var(--err); }
.warn-text { color: var(--warn); font-size: calc(var(--ui-font-size) - 1.5px); }
.center-hint {
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--dim);
}

/* Device-code body */
.nb {
  padding: 18px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.nb-lead {
  font-size: var(--ui-font-size);
  color: var(--text);
  line-height: 1.6;
}

/* Primary path: open the complete URI (device code embedded) */
.nb-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  background: var(--blue);
  color: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 5px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  font-weight: 600;
  padding: 11px 14px;
  cursor: pointer;
  text-decoration: none;
}
.nb-primary:hover { background: var(--blue2); border-color: var(--blue2); }

/* "or" divider */
.nb-or {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: max(9px, calc(var(--ui-font-size) - 2.5px));
  letter-spacing: 0.06em;
}
.nb-or::before,
.nb-or::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}

/* Fallback path: open plain URI, type the code */
.nb-fallback {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.nb-fb-text {
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--dim);
  line-height: 1.6;
}
.nb-fb-link {
  color: var(--blue);
  text-decoration: none;
  border-bottom: 1px solid var(--bd);
}
.nb-fb-link:hover { border-bottom-color: var(--blue); }
.nb-code-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 9px 11px;
}
.nb-code {
  flex: 1;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) + 5px);
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 0.14em;
}
.nb-copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  padding: 5px 11px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: none;
  color: var(--text);
  cursor: pointer;
  flex: none;
  transition: background 0.1s;
}
.nb-copy:hover { background: var(--soft); }
.nb-copy.is-copied { color: var(--ok); border-color: var(--ok); }

/* Status */
.nb-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 11px;
  border-top: 1px solid var(--line2);
}
.nb-spinner { display: flex; align-items: center; }
.nb-status-text { font-size: calc(var(--ui-font-size) - 1.5px); color: var(--dim); flex: 1; }
.nb-countdown {
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* Actions */
.actions {
  display: flex;
  gap: 8px;
  padding: 0 14px 14px;
}
.act-btn {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 5px 14px;
  cursor: pointer;
  color: var(--text);
}
.act-btn:hover { background: var(--panel2); }
.act-btn.primary {
  background: var(--blue);
  border-color: var(--blue);
  color: var(--bg);
}
.act-btn.primary:hover { background: var(--blue2); }

@media (max-width: 640px) {
  .backdrop {
    align-items: stretch;
    padding:
      max(12px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .dialog {
    width: 100%;
    max-width: none;
    height: auto;
    max-height: calc(100dvh - 24px);
    overflow: hidden;
  }
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
  .actions {
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }
  .act-btn {
    min-height: 36px;
  }
}
</style>
