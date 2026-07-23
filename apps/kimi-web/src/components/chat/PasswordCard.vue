<!-- apps/kimi-web/src/components/chat/PasswordCard.vue -->
<!-- Sudo askpass card (GitHub issue #2090): a running bash command hit sudo -->
<!-- and the daemon is waiting for the user's password. The password is only -->
<!-- ever held in the input's local ref for the in-flight submit and cleared -->
<!-- immediately on submit/cancel — it never reaches state, logs, or the model. -->
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppPasswordRequest } from '../../api/types';
import Card from '../ui/Card.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';

const props = defineProps<{
  password: AppPasswordRequest;
  /** True while a respond for this password request is in flight. Drives the
   *  action buttons' loading/disabled state and blocks duplicate submits. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  submit: [passwordId: string, password: string];
  cancel: [passwordId: string];
}>();

const { t } = useI18n();

// The only place the secret ever lives client-side, and only until the user
// submits or cancels — both paths clear it immediately (before the respond
// round-trip completes), so a rerender can never re-display it.
const value = ref('');
const inputRef = ref<{ focus: () => void } | null>(null);

// The action the user just triggered, kept locally so its button can show a
// spinner. The card unmounts on a successful respond; on failure `busy` flips
// back to false and we clear this so the buttons re-enable for retry.
const pendingAction = ref<'submit' | 'cancel' | null>(null);
watch(
  () => props.busy,
  (b) => {
    if (!b) pendingAction.value = null;
  },
);

function submit(): void {
  if (props.busy) return;
  const password = value.value;
  if (password.length === 0) return;
  // Clear BEFORE emitting so the secret leaves local state immediately.
  value.value = '';
  pendingAction.value = 'submit';
  emit('submit', props.password.passwordId, password);
}

function cancel(): void {
  if (props.busy) return;
  value.value = '';
  pendingAction.value = 'cancel';
  emit('cancel', props.password.passwordId);
}

onMounted(() => {
  setTimeout(() => inputRef.value?.focus(), 0);
});
</script>

<template>
  <Card class="pw">
    <!-- Header -->
    <template #head>
      <div class="ph">
        <span class="ph-ic"><Icon name="lock" size="md" /></span>
        <span class="pkind">{{ t('password.title') }}</span>
        <Badge variant="warning" size="sm" class="pw-req">{{ t('password.required') }}</Badge>
      </div>
    </template>

    <template #default>
      <!-- The exact sudo prompt text (e.g. "[sudo] password for alice:") -->
      <div class="pw-prompt">{{ password.prompt }}</div>

      <!-- The command that triggered the prompt, when the daemon reports it -->
      <div v-if="password.command" class="shell-cmd">
        <span class="shell-dollar">$</span> {{ password.command }}
      </div>

      <Input
        ref="inputRef"
        v-model="value"
        type="password"
        :placeholder="t('password.placeholder')"
        :disabled="busy"
        autocomplete="off"
        @keydown.enter.prevent="submit"
        @keydown.esc.prevent="cancel"
      />
      <div class="pw-hint">{{ t('password.hint') }}</div>
    </template>

    <!-- Actions -->
    <template #foot>
      <div class="abtn">
        <Button
          class="kbtn"
          size="sm"
          variant="primary"
          :loading="pendingAction === 'submit'"
          :disabled="busy || value.length === 0"
          @click="submit"
        >{{ t('password.submit') }}</Button>
        <Button
          class="kbtn"
          size="sm"
          variant="secondary"
          :loading="pendingAction === 'cancel'"
          :disabled="busy"
          @click="cancel"
        >{{ t('password.cancel') }}</Button>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.pw {
  margin: var(--space-2) 0;
}
/* Same warning attention-card band as ApprovalCard — sudo blocks a running
   process, so it reads as an action-required interrupt. */
.pw.ui-card { border-color: var(--color-warning-bd); }
.pw :deep(.ui-card__head) {
  background: var(--color-warning-soft);
  border-bottom-color: var(--color-warning-bd);
}

/* Header — single row: lock + title on the left, "required" badge pinned right. */
.ph {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  flex-wrap: nowrap;
}
.ph-ic {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-warning);
  flex: none;
}
.pkind {
  color: var(--color-warning);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
  flex: none;
}
.pw-req {
  margin-left: auto;
}

.pw-prompt {
  font: var(--text-sm) var(--font-mono);
  color: var(--color-text);
  margin-bottom: var(--space-2);
  word-break: break-all;
}

.shell-cmd {
  font: var(--text-sm) var(--font-mono);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
  color: var(--color-text);
  margin-bottom: var(--space-2);
}
.shell-dollar { color: var(--color-accent-hover); font-weight: var(--weight-medium); margin-right: var(--space-2); }

.pw-hint {
  font: var(--text-xs) var(--font-ui);
  color: var(--color-text-muted);
  margin-top: var(--space-1);
}

/* Actions row — right-aligned sm buttons (primary / secondary). */
.abtn {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}

/* =========================================================================
   MOBILE (≤640px): the action buttons become a stack of ≥44px tall,
   easily-tappable targets (same treatment as ApprovalCard).
   ========================================================================= */
@media (max-width: 640px) {
  .abtn { flex-direction: column; }
  .kbtn {
    width: 100%;
    min-height: 46px;
  }
}
</style>
