<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useOAuthLoginFlow } from '@moonshot-ai/app-client/composables';
import { AuthStateIcon, Button, Spinner } from '@moonshot-ai/app-ui';
import { createAuthLoginFlow, type AuthStartError, type AuthStartErrorKind } from './flow';
import { exchangeSession, ExchangeError } from './session';

const props = defineProps<{
  redirectUri: string | null;
}>();

const emit = defineEmits<{
  authenticated: [];
}>();

const { t, locale } = useI18n();

const exchangeFailed = ref(false);
const exchangeStatus = ref<number | null>(null);
const started = ref(false);
const startError = ref<AuthStartError | null>(null);
const errorDetailsExpanded = ref(false);
const errorDetailsCopied = ref(false);

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
  successDwellMs: props.redirectUri === null ? 0 : undefined,
});

const displayStep = computed(() => {
  if (exchangeFailed.value) return 'exchange-error';
  if (!started.value) return 'entry';
  return step.value;
});

const startErrorHintKeys: Record<AuthStartErrorKind, string> = {
  offline: 'login.rcOfflineErrorHint',
  connection: 'login.rcConnectionStartErrorHint',
  timeout: 'login.rcTimeoutErrorHint',
  'rate-limited': 'login.rcRateLimitedErrorHint',
  'service-unavailable': 'login.rcServiceUnavailableErrorHint',
  'request-rejected': 'login.rcRequestRejectedErrorHint',
  'invalid-response': 'login.rcInvalidResponseErrorHint',
  unknown: 'login.rcStartErrorFallbackHint',
};

const startErrorKindKeys: Record<AuthStartErrorKind, string> = {
  offline: 'login.rcErrorKindOffline',
  connection: 'login.rcErrorKindConnection',
  timeout: 'login.rcErrorKindTimeout',
  'rate-limited': 'login.rcErrorKindRateLimited',
  'service-unavailable': 'login.rcErrorKindServiceUnavailable',
  'request-rejected': 'login.rcErrorKindRequestRejected',
  'invalid-response': 'login.rcErrorKindInvalidResponse',
  unknown: 'login.rcErrorKindUnknown',
};

const startErrorHint = computed(() => startError.value
  ? t(startErrorHintKeys[startError.value.kind])
  : t('login.rcConnectionErrorHint'));

function formatOccurredAt(value: string): string {
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function detailLine(label: string, value: string | number): string {
  return `${label}${locale.value === 'zh' ? '：' : ': '}${value}`;
}

const errorCodeText = computed(() => startError.value
  ? detailLine(t('login.rcErrorCode'), startError.value.code)
  : '');

const errorDetailsText = computed(() => {
  const error = startError.value;
  if (!error) return '';
  const lines = [
    detailLine(t('login.rcErrorStage'), t('login.rcErrorStageDeviceAuthorization')),
    detailLine(t('login.rcErrorKind'), t(startErrorKindKeys[error.kind])),
    errorCodeText.value,
  ];
  if (error.status !== undefined) lines.push(detailLine(t('login.rcErrorHttpStatus'), error.status));
  if (error.requestId) lines.push(detailLine(t('login.rcErrorRequestId'), error.requestId));
  lines.push(detailLine(t('login.rcErrorOccurredAt'), formatOccurredAt(error.occurredAt)));
  lines.push(detailLine(t('login.rcErrorService'), error.oauthHost));
  if (error.description) lines.push(detailLine(t('login.rcErrorDescription'), error.description));
  return lines.join('\n');
});

async function finishSignIn(): Promise<void> {
  try {
    await pendingExchange;
  } catch (err) {
    exchangeStatus.value = err instanceof ExchangeError ? err.status : null;
    exchangeFailed.value = true;
    return;
  }
  const target = props.redirectUri;
  if (target) {
    location.replace(target);
  } else {
    emit('authenticated');
  }
}

async function retryExchange(): Promise<void> {
  const status = exchangeStatus.value;
  exchangeFailed.value = false;
  exchangeStatus.value = null;
  if (status !== null && status >= 400 && status < 500) {
    await beginFlow();
    return;
  }
  runExchange();
  await finishSignIn();
}

let authTab: Window | null = null;

async function beginFlow(): Promise<void> {
  started.value = true;
  startError.value = null;
  errorDetailsExpanded.value = false;
  errorDetailsCopied.value = false;
  authTab = window.open('', '_blank');
  if (authTab) authTab.opener = null;
  await startFlow();
  if (step.value === 'error' && !pollError.value) {
    startError.value = authFlow.startError();
  }
}

watch(flow, (f) => {
  if (!f) return;
  const url = f.verificationUriComplete;
  if (authTab && !authTab.closed) {
    authTab.location.href = url;
  } else {
    authTab = window.open(url, '_blank', 'noopener,noreferrer');
  }
});

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

async function copyErrorDetails(): Promise<void> {
  if (!startError.value) return;
  const ok = await copyTextToClipboard(errorDetailsText.value);
  if (!ok) return;
  errorDetailsCopied.value = true;
  setTimeout(() => {
    errorDetailsCopied.value = false;
  }, 2000);
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
</script>

<template>
  <Transition name="step" mode="out-in">
    <div v-if="displayStep === 'starting'" key="busy" class="center-body">
      <Spinner size="md" />
      <span class="center-text">{{ t('login.starting') }}</span>
    </div>

    <div v-else-if="displayStep === 'entry'" key="entry" class="center-body">
      <p class="lead">{{ t('login.rcLead') }}</p>
      <Button variant="primary" class="entry-btn" @click="beginFlow">{{ t('login.action') }}</Button>
    </div>

    <div v-else-if="displayStep === 'device-code' && flow" key="device-code" class="flow-body">
      <p class="lead">{{ t('login.openedHint', { time: formatSeconds(secondsLeft) }) }}</p>

      <span class="manual-label">
        {{ t('login.notOpened') }}
        <Button variant="text" class="copy-text" :class="{ 'is-copied': copied }" @click="copyLink">
          {{ copied ? t('login.copied') : t('login.copyLink') }}
        </Button>
      </span>
    </div>

    <div v-else-if="displayStep === 'success'" key="success" class="center-body">
      <template v-if="redirectUri">
        <AuthStateIcon kind="success" />
        <span class="center-text success-text">{{ t('login.success') }}</span>
        <span class="center-hint">{{ t('login.rcSuccessHint') }}</span>
      </template>
      <template v-else>
        <Spinner size="md" />
        <span class="center-text">{{ t('login.success') }}</span>
      </template>
    </div>

    <div v-else-if="displayStep === 'denied'" key="denied" class="center-body">
      <AuthStateIcon kind="expired" />
      <span class="center-text err-text">{{ t('login.rcDeniedTitle') }}</span>
      <span class="center-hint">{{ t('login.expiredHint') }}</span>
      <Button variant="primary" class="retry-btn" @click="beginFlow">{{ t('login.retry') }}</Button>
    </div>

    <div v-else-if="displayStep === 'expired'" key="expired" class="center-body">
      <AuthStateIcon kind="expired" />
      <span class="center-text err-text">{{ t('login.rcExpiredTitle') }}</span>
      <span class="center-hint">{{ t('login.expiredHint') }}</span>
      <Button variant="primary" class="retry-btn" @click="beginFlow">{{ t('login.retry') }}</Button>
    </div>

    <div v-else-if="displayStep === 'error'" key="error" class="center-body">
      <AuthStateIcon kind="error" />
      <span class="center-text warn-text">
        {{ pollError ? t('login.pollErrorTitle') : t('login.rcStartErrorTitle') }}
      </span>
      <span class="center-hint">{{ pollError ? t('login.rcConnectionErrorHint') : startErrorHint }}</span>
      <Button variant="primary" class="retry-btn" @click="beginFlow">{{ t('login.retry') }}</Button>
      <template v-if="startError">
        <Button
          variant="text"
          class="error-details-toggle"
          :aria-expanded="errorDetailsExpanded"
          aria-controls="rc-start-error-details"
          @click="errorDetailsExpanded = !errorDetailsExpanded"
        >
          {{ errorDetailsExpanded ? t('login.rcHideErrorDetails') : t('login.rcViewErrorDetails') }}
        </Button>
        <div v-if="errorDetailsExpanded" id="rc-start-error-details" class="error-details">
          <dl class="error-details-list">
            <div class="error-detail-row">
              <dt>{{ t('login.rcErrorStage') }}</dt>
              <dd>{{ t('login.rcErrorStageDeviceAuthorization') }}</dd>
            </div>
            <div class="error-detail-row">
              <dt>{{ t('login.rcErrorKind') }}</dt>
              <dd>{{ t(startErrorKindKeys[startError.kind]) }}</dd>
            </div>
            <div v-if="startError.status !== undefined" class="error-detail-row">
              <dt>{{ t('login.rcErrorHttpStatus') }}</dt>
              <dd class="diagnostic-value">{{ startError.status }}</dd>
            </div>
            <div v-if="startError.requestId" class="error-detail-row">
              <dt>{{ t('login.rcErrorRequestId') }}</dt>
              <dd class="diagnostic-value">{{ startError.requestId }}</dd>
            </div>
            <div class="error-detail-row">
              <dt>{{ t('login.rcErrorOccurredAt') }}</dt>
              <dd class="diagnostic-value">{{ formatOccurredAt(startError.occurredAt) }}</dd>
            </div>
            <div class="error-detail-row">
              <dt>{{ t('login.rcErrorService') }}</dt>
              <dd class="diagnostic-value">{{ startError.oauthHost }}</dd>
            </div>
          </dl>
          <div v-if="startError.description" class="error-description">
            <span>{{ t('login.rcErrorDescription') }}</span>
            <p>{{ startError.description }}</p>
          </div>
          <Button variant="secondary" size="sm" class="copy-details-btn" @click="copyErrorDetails">
            {{ errorDetailsCopied ? t('login.copied') : t('login.rcCopyErrorDetails') }}
          </Button>
        </div>
        <code class="error-code">{{ errorCodeText }}</code>
      </template>
    </div>

    <div v-else-if="displayStep === 'exchange-error'" key="exchange-error" class="center-body">
      <AuthStateIcon kind="error" />
      <span class="center-text warn-text">{{ t('login.rcSessionErrorTitle') }}</span>
      <span class="center-hint">{{ t('login.rcConnectionErrorHint') }}</span>
      <Button variant="primary" class="retry-btn" @click="retryExchange">{{ t('login.retry') }}</Button>
    </div>
  </Transition>
</template>

<style scoped>
.entry-btn {
  align-self: center;
  padding: 0 var(--space-6);
}

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

.manual-label {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  text-align: center;
}
.copy-text { margin-left: var(--space-2); }
.copy-text.is-copied { color: var(--color-success); text-decoration: none; }

.error-details-toggle {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  text-decoration: none;
}
.error-details {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-4);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  text-align: left;
}
.error-details-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}
.error-detail-row {
  display: grid;
  grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  gap: var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.error-detail-row dt { color: var(--color-text-muted); }
.error-detail-row dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.diagnostic-value {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.error-description {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.error-description p {
  margin: var(--space-1) 0 0;
  color: var(--color-text);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.copy-details-btn {
  width: 100%;
  margin-top: var(--space-4);
}
.error-code {
  max-width: 100%;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}
</style>
