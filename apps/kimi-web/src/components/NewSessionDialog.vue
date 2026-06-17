<!-- apps/kimi-web/src/components/NewSessionDialog.vue -->
<!-- Modal dialog for creating a new session with a required working directory. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  recentCwds: string[];
}>();

const emit = defineEmits<{
  create: [payload: { cwd: string; title?: string }];
  close: [];
}>();

// -------------------------------------------------------------------------
// Form state
// -------------------------------------------------------------------------

const cwdInput = ref('');
const titleInput = ref('');

// Pre-fill with the first recentCwd if available
watch(
  () => props.recentCwds,
  (cwds) => {
    if (cwdInput.value === '' && cwds.length > 0) {
      cwdInput.value = cwds[0]!;
    }
  },
  { immediate: true },
);

const cwdTrimmed = computed(() => cwdInput.value.trim());
const canCreate = computed(() => cwdTrimmed.value.length > 0);

// -------------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------------

function handleCreate(): void {
  if (!canCreate.value) return;
  const payload: { cwd: string; title?: string } = { cwd: cwdTrimmed.value };
  const titleTrimmed = titleInput.value.trim();
  if (titleTrimmed) payload.title = titleTrimmed;
  emit('create', payload);
}

function pickRecent(cwd: string): void {
  cwdInput.value = cwd;
}

// -------------------------------------------------------------------------
// Keyboard
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close');
  } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
    handleCreate();
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <!-- Backdrop -->
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" :aria-label="t('newSession.title')">

      <!-- Header -->
      <div class="dh">
        <span class="dtitle">{{ t('newSession.title') }}</span>
        <button class="close-btn" :title="t('newSession.close')" @click="emit('close')">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="form-body">

        <!-- Working directory (required) -->
        <div class="form-row">
          <label class="flabel" for="ns-cwd">{{ t('newSession.cwdLabel') }}</label>
          <input
            id="ns-cwd"
            v-model="cwdInput"
            class="finput"
            type="text"
            :placeholder="t('newSession.cwdPlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <!-- Recent cwds quick-pick -->
        <div v-if="recentCwds.length > 0" class="recent-section">
          <div class="recent-label">{{ t('newSession.recentLabel') }}</div>
          <div class="recent-list">
            <button
              v-for="cwd in recentCwds"
              :key="cwd"
              class="recent-item"
              :class="{ 'is-active': cwdInput === cwd }"
              :title="cwd"
              @click="pickRecent(cwd)"
            >
              <svg class="dir-icon" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="1" y="3" width="9" height="6.5" rx="1"/>
                <path d="M1 4.5V3a1 1 0 0 1 1-1h2.5l1 1.5"/>
              </svg>
              <span class="recent-path">{{ cwd }}</span>
            </button>
          </div>
        </div>

        <!-- Title (optional) -->
        <div class="form-row">
          <label class="flabel" for="ns-title">{{ t('newSession.titleFieldLabel') }}</label>
          <input
            id="ns-title"
            v-model="titleInput"
            class="finput"
            type="text"
            :placeholder="t('newSession.titleFieldPlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

      </div>

      <!-- Actions -->
      <div class="actions">
        <button class="act-btn primary" :disabled="!canCreate" @click="handleCreate">{{ t('newSession.create') }}</button>
        <button class="act-btn" @click="emit('close')">{{ t('newSession.cancel') }}</button>
      </div>

      <div class="footer-hint">{{ t('newSession.footerHint') }}</div>

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
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  width: 520px;
  max-width: calc(100vw - 32px);
  height: 360px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
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

/* Form body */
.form-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
}

.form-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.flabel {
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--dim);
  width: 66px;
  flex: none;
  text-align: right;
  padding-top: 5px;
}
.finput {
  flex: 1;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.finput:focus-visible {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 25%, transparent);
}


/* Recent cwds section */
.recent-section {
  padding-left: 76px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.recent-label {
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 3px 7px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--text);
  text-align: left;
  transition: background 0.1s;
}
.recent-item:hover {
  background: var(--panel2);
  border-color: var(--line);
}
.recent-item.is-active {
  background: var(--soft);
  border-color: var(--bd);
  color: var(--blue);
}
.dir-icon {
  flex: none;
  color: var(--muted);
}
.recent-item.is-active .dir-icon {
  color: var(--blue);
}
.recent-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
.act-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.act-btn.primary {
  background: var(--blue);
  border-color: var(--blue);
  color: var(--bg);
}
.act-btn.primary:hover:not(:disabled) { background: var(--blue2); }

/* Footer */
.footer-hint {
  padding: 6px 14px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
  border-radius: 0 0 4px 4px;
}

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
  }
  .form-body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .form-row {
    flex-direction: column;
    gap: 5px;
  }
  .flabel {
    width: auto;
    text-align: left;
    padding-top: 0;
  }
  .finput {
    width: 100%;
    box-sizing: border-box;
  }
  .recent-section {
    padding-left: 0;
  }
  .actions {
    flex-wrap: wrap;
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }
  .act-btn {
    min-height: 36px;
  }
  .act-btn.primary {
    flex: 1 1 100%;
  }
}
</style>
