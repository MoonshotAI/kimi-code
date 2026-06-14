<!-- apps/kimi-web/src/components/SettingsDialog.vue -->
<!-- The app's dedicated Settings page (modal). Consolidates what used to be
     scattered in the sidebar account popover: appearance, language, account,
     connection, plus notifications and the troubleshooting-log export. -->
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import LanguageSwitcher from './LanguageSwitcher.vue';
import { serverEndpointLabel } from '../api/config';
import { downloadTraceLog, isTraceEnabled } from '../debug/trace';
import type { Accent, ColorScheme, Theme } from '../composables/useKimiWebClient';

const { t } = useI18n();

const props = defineProps<{
  theme: Theme;
  colorScheme: ColorScheme;
  accent: Accent;
  uiFontSize: number;
  authReady: boolean;
  accountModel?: string | null;
  /** Browser-notification-on-completion preference. */
  notify: boolean;
  /** OS permission state ('default' | 'granted' | 'denied') for the hint. */
  notifyPermission?: string;
}>();

const emit = defineEmits<{
  setTheme: [theme: Theme];
  setColorScheme: [colorScheme: ColorScheme];
  setAccent: [accent: Accent];
  setUiFontSize: [size: number];
  setNotify: [on: boolean];
  login: [];
  logout: [];
  openOnboarding: [];
  close: [];
}>();

const daemonEndpoint = serverEndpointLabel();

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

function exportLog(): void {
  downloadTraceLog();
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" :aria-label="t('settings.title')">
      <div class="dh">
        <span class="dtitle">{{ t('settings.title') }}</span>
        <button class="close-btn" :title="t('newSession.close')" @click="emit('close')">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <div class="body">
        <!-- Appearance -->
        <section class="sec">
          <h3 class="sec-title">{{ t('settings.appearance') }}</h3>
          <div class="row">
            <span class="rlabel">{{ t('theme.label') }}</span>
            <div class="seg" role="group" :aria-label="t('theme.label')">
              <button type="button" class="opt" :class="{ on: theme === 'modern' }" :aria-pressed="theme === 'modern'" @click="emit('setTheme', 'modern')">{{ t('theme.modern') }}</button>
              <button type="button" class="opt" :class="{ on: theme === 'kimi' }" :aria-pressed="theme === 'kimi'" @click="emit('setTheme', 'kimi')">{{ t('theme.kimi') }}</button>
            </div>
          </div>
          <div class="row">
            <span class="rlabel">{{ t('theme.colorSchemeLabel') }}</span>
            <div class="seg" role="group" :aria-label="t('theme.colorSchemeLabel')">
              <button type="button" class="opt" :class="{ on: colorScheme === 'light' }" :aria-pressed="colorScheme === 'light'" @click="emit('setColorScheme', 'light')">{{ t('theme.light') }}</button>
              <button type="button" class="opt" :class="{ on: colorScheme === 'dark' }" :aria-pressed="colorScheme === 'dark'" @click="emit('setColorScheme', 'dark')">{{ t('theme.dark') }}</button>
              <button type="button" class="opt" :class="{ on: colorScheme === 'system' }" :aria-pressed="colorScheme === 'system'" @click="emit('setColorScheme', 'system')">{{ t('theme.system') }}</button>
            </div>
          </div>
          <!-- Accent is pinned by the Kimi theme, so hide the choice there. -->
          <div v-if="theme !== 'kimi'" class="row">
            <span class="rlabel">{{ t('theme.accentLabel') }}</span>
            <div class="seg" role="group" :aria-label="t('theme.accentLabel')">
              <button type="button" class="opt" :class="{ on: accent === 'blue' }" :aria-pressed="accent === 'blue'" @click="emit('setAccent', 'blue')">{{ t('theme.accentBlue') }}</button>
              <button type="button" class="opt" :class="{ on: accent === 'mono' }" :aria-pressed="accent === 'mono'" @click="emit('setAccent', 'mono')">{{ t('theme.accentMono') }}</button>
            </div>
          </div>
          <div class="row">
            <span class="rlabel">{{ t('settings.uiFontSize') }}</span>
            <label class="num-field">
              <input
                class="num-input"
                type="number"
                min="12"
                max="20"
                step="1"
                :value="uiFontSize"
                :aria-label="t('settings.uiFontSize')"
                @input="emit('setUiFontSize', Number(($event.target as HTMLInputElement).value))"
              />
              <span class="num-unit">px</span>
            </label>
          </div>
          <div class="row">
            <span class="rlabel">{{ t('sidebar.language') }}</span>
            <LanguageSwitcher />
          </div>
        </section>

        <!-- Notifications -->
        <section class="sec">
          <h3 class="sec-title">{{ t('settings.notifications') }}</h3>
          <div class="row">
            <span class="rlabel">
              {{ t('settings.notifyOnComplete') }}
              <span v-if="notifyPermission === 'denied'" class="hint">{{ t('settings.notifyDenied') }}</span>
            </span>
            <button
              type="button"
              class="switch"
              role="switch"
              :class="{ on: notify }"
              :aria-checked="notify"
              :disabled="notifyPermission === 'denied'"
              @click="emit('setNotify', !notify)"
            >
              <span class="knob" />
            </button>
          </div>
        </section>

        <!-- Account -->
        <section class="sec">
          <h3 class="sec-title">{{ t('settings.account') }}</h3>
          <div class="row">
            <span class="rlabel">{{ authReady ? 'managed:kimi-code' : t('sidebar.notSignedIn') }}</span>
            <span v-if="authReady && accountModel" class="rvalue" :title="accountModel">{{ accountModel }}</span>
          </div>
          <div class="actions">
            <button type="button" class="act" @click="emit('openOnboarding'); emit('close')">{{ t('onboarding.reopen') }}</button>
            <button v-if="authReady" type="button" class="act danger" @click="emit('logout')">{{ t('sidebar.signOut') }}</button>
            <button v-else type="button" class="act signin" @click="emit('login')">{{ t('sidebar.signIn') }}</button>
          </div>
        </section>

        <!-- Connection + logs -->
        <section class="sec">
          <h3 class="sec-title">{{ t('settings.advanced') }}</h3>
          <div class="row">
            <span class="rlabel">{{ t('sidebar.daemon') }}</span>
            <span class="rvalue mono">{{ daemonEndpoint }}</span>
          </div>
          <div class="row">
            <span class="rlabel">
              {{ t('settings.exportLog') }}
              <span v-if="!isTraceEnabled()" class="hint">{{ t('settings.logHint') }}</span>
            </span>
            <button type="button" class="act" @click="exportLog">{{ t('settings.exportLogBtn') }}</button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 23, 28, 0.42);
  padding: 24px;
}
.dialog {
  width: min(520px, 100%);
  max-height: min(82vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.dh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.dtitle { font-family: var(--sans); font-size: 15px; font-weight: 600; color: var(--ink); }
.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.close-btn:hover { background: var(--soft); color: var(--ink); }

.body { overflow-y: auto; padding: 6px 16px 16px; }
.sec { padding: 12px 0; border-bottom: 1px solid var(--line); }
.sec:last-child { border-bottom: none; }
.sec-title {
  margin: 0 0 10px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 3px 0;
}
.rlabel { font-family: var(--sans); font-size: 13.5px; color: var(--ink); display: flex; flex-direction: column; gap: 2px; }
.rvalue { font-family: var(--sans); font-size: 12.5px; color: var(--muted); max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rvalue.mono { font-family: var(--mono); font-size: 12px; }
.hint { font-size: 11px; color: var(--faint); font-family: var(--sans); }

.num-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 0 8px;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
}
.num-input {
  width: 48px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 13px;
  text-align: right;
}
.num-unit {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
}

.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.opt {
  border: none;
  background: var(--bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  border-left: 1px solid var(--line);
}
.opt:first-child { border-left: none; }
.opt:hover { color: var(--ink); }
.opt.on { background: var(--soft); color: var(--blue2); font-weight: 600; }

.toggle-row { cursor: pointer; }
.switch {
  flex: none;
  width: 40px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel2);
  position: relative;
  cursor: pointer;
  transition: background 0.16s;
  padding: 0;
}
.switch.on { background: var(--blue); border-color: var(--blue); }
.switch:disabled { opacity: 0.5; cursor: not-allowed; }
.knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.16s;
}
.switch.on .knob { transform: translateX(18px); }

.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.act {
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 12.5px;
  padding: 6px 12px;
  cursor: pointer;
}
.act:hover { background: var(--soft); border-color: var(--bd); }
.act.signin { background: var(--blue); color: var(--bg); border-color: var(--blue); }
.act.signin:hover { background: var(--blue2); }
.act.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 30%, var(--line)); }
.act.danger:hover { background: color-mix(in srgb, var(--err) 8%, var(--bg)); }
</style>
