<!-- apps/kimi-web/src/components/SettingsDialog.vue -->
<!-- The app's dedicated Settings page (modal). Consolidates what used to be
     scattered in the sidebar account popover: appearance, language, account,
     connection, plus notifications and the troubleshooting-log export. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDialogFocus } from '../composables/useDialogFocus';
import LanguageSwitcher from './LanguageSwitcher.vue';
import { serverEndpointLabel } from '../api/config';
import { downloadTraceLog, isTraceEnabled } from '../debug/trace';
import type { ColorScheme, Theme } from '../composables/useKimiWebClient';
import type { AppConfig, AppConfigProvider, AppModel } from '../api/types';

const { t } = useI18n();

const props = defineProps<{
  theme: Theme;
  colorScheme: ColorScheme;
  uiFontSize: number;
  authReady: boolean;
  accountModel?: string | null;
  /** Browser-notification-on-completion preference. */
  notify: boolean;
  /** OS permission state ('default' | 'granted' | 'denied') for the hint. */
  notifyPermission?: string;
  /** Beta conversation TOC (proportional, viewport, hover tooltip). */
  betaToc?: boolean;
  /** Global daemon config from GET /api/v1/config. Secrets are redacted server-side. */
  config?: AppConfig | null;
  /** Models from the daemon catalog, used to label default-model choices. */
  models?: AppModel[];
  /** True while POST /api/v1/config is saving. */
  configSaving?: boolean;
}>();

const emit = defineEmits<{
  setTheme: [theme: Theme];
  setColorScheme: [colorScheme: ColorScheme];
  setUiFontSize: [size: number];
  setNotify: [on: boolean];
  setBetaToc: [on: boolean];
  login: [];
  logout: [];
  openOnboarding: [];
  updateConfig: [patch: Partial<AppConfig>];
  close: [];
}>();

type SettingsTab = 'general' | 'agent' | 'advanced' | 'experimental';

const activeTab = ref<SettingsTab>('general');

const tabs: { id: SettingsTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tabs.general' },
  { id: 'agent', labelKey: 'settings.tabs.agent' },
  { id: 'advanced', labelKey: 'settings.tabs.advanced' },
  { id: 'experimental', labelKey: 'settings.tabs.experimental' },
];

const daemonEndpoint = serverEndpointLabel();
const permissionModes = ['manual', 'auto', 'yolo'] as const;

// Modal focus: move focus into the dialog on open, restore it to the opener on
// close (Escape-to-close is handled below).
const dialogRef = ref<HTMLElement | null>(null);
useDialogFocus(dialogRef);

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

function exportLog(): void {
  downloadTraceLog();
}

type ModelOption = { id: string; label: string };

const modelOptions = computed<ModelOption[]>(() => {
  const byId = new Map<string, string>();
  for (const model of props.models ?? []) {
    byId.set(model.id, model.displayName ?? model.model ?? model.id);
  }
  for (const [id, raw] of Object.entries(props.config?.models ?? {})) {
    if (byId.has(id)) continue;
    byId.set(id, formatConfigModelLabel(id, raw));
  }
  return Array.from(byId, ([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
});

const providerEntries = computed<Array<{ id: string; provider: AppConfigProvider }>>(() =>
  Object.entries(props.config?.providers ?? {})
    .map(([id, provider]) => ({ id, provider }))
    .sort((a, b) => a.id.localeCompare(b.id)),
);

const defaultPermissionMode = computed(() => {
  const mode = props.config?.defaultPermissionMode;
  return mode === 'auto' || mode === 'yolo' || mode === 'manual' ? mode : 'manual';
});

function formatConfigModelLabel(id: string, raw: unknown): string {
  if (!raw || typeof raw !== 'object') return id;
  const source = raw as Record<string, unknown>;
  const model = typeof source['model'] === 'string' ? source['model'] : undefined;
  const provider = typeof source['provider'] === 'string' ? source['provider'] : undefined;
  if (model && provider) return `${id} (${provider}/${model})`;
  if (model) return `${id} (${model})`;
  return id;
}

function configBool(value: boolean | undefined): boolean {
  return value === true;
}

function setDefaultModel(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!value || value === props.config?.defaultModel) return;
  emit('updateConfig', { defaultModel: value });
}

function setDefaultPermissionMode(mode: 'manual' | 'auto' | 'yolo'): void {
  if (mode === defaultPermissionMode.value) return;
  emit('updateConfig', { defaultPermissionMode: mode });
}

function toggleConfigBoolean(key: 'defaultThinking' | 'defaultPlanMode' | 'mergeAllAvailableSkills' | 'telemetry'): void {
  const current = props.config?.[key];
  emit('updateConfig', { [key]: !configBool(current) } as Partial<AppConfig>);
}

function setTab(tab: SettingsTab): void {
  activeTab.value = tab;
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-label="t('settings.title')">
      <div class="dh">
        <span class="dtitle">{{ t('settings.title') }}</span>
        <button class="close-btn" :title="t('newSession.close')" @click="emit('close')">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <div class="settings-layout">
        <nav class="settings-tabs" role="tablist" :aria-label="t('settings.title')">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            class="tab"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="`settings-panel-${tab.id}`"
            :id="`settings-tab-${tab.id}`"
            :class="{ on: activeTab === tab.id }"
            @click="setTab(tab.id)"
          >
            {{ t(tab.labelKey) }}
          </button>
        </nav>

        <div class="body">
          <!-- General: Appearance + Notifications + Account -->
          <section
            v-show="activeTab === 'general'"
            :id="`settings-panel-general`"
            class="panel"
            role="tabpanel"
            aria-labelledby="settings-tab-general"
          >
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
          </section>

          <!-- Agent defaults -->
          <section
            v-show="activeTab === 'agent'"
            :id="`settings-panel-agent`"
            class="panel"
            role="tabpanel"
            aria-labelledby="settings-tab-agent"
          >
            <section class="sec">
              <div class="sec-head">
                <h3 class="sec-title">{{ t('settings.agentDefaults') }}</h3>
                <span v-if="configSaving" class="saving">{{ t('settings.saving') }}</span>
              </div>

              <template v-if="config">
                <div class="row">
                  <span class="rlabel">
                    {{ t('settings.defaultModel') }}
                    <span class="hint">{{ t('settings.defaultModelHint') }}</span>
                  </span>
                  <select
                    v-if="modelOptions.length > 0"
                    class="select-field"
                    :value="config.defaultModel ?? ''"
                    :disabled="configSaving"
                    :aria-label="t('settings.defaultModel')"
                    @change="setDefaultModel"
                  >
                    <option v-if="!config.defaultModel" value="" disabled>{{ t('settings.noDefaultModel') }}</option>
                    <option v-for="model in modelOptions" :key="model.id" :value="model.id">
                      {{ model.label }}
                    </option>
                  </select>
                  <span v-else class="rvalue mono">{{ config.defaultModel ?? t('settings.noDefaultModel') }}</span>
                </div>

                <div class="row">
                  <span class="rlabel">
                    {{ t('settings.defaultPermission') }}
                    <span class="hint">{{ t('settings.defaultPermissionHint') }}</span>
                  </span>
                  <div class="seg" role="group" :aria-label="t('settings.defaultPermission')">
                    <button
                      v-for="mode in permissionModes"
                      :key="mode"
                      type="button"
                      class="opt"
                      :class="{ on: defaultPermissionMode === mode }"
                      :aria-pressed="defaultPermissionMode === mode"
                      :disabled="configSaving"
                      @click="setDefaultPermissionMode(mode)"
                    >
                      {{ t(`settings.permission.${mode}`) }}
                    </button>
                  </div>
                </div>

                <div class="row">
                  <span class="rlabel">
                    {{ t('settings.defaultThinking') }}
                    <span class="hint">{{ t('settings.defaultThinkingHint') }}</span>
                  </span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :class="{ on: configBool(config.defaultThinking) }"
                    :aria-checked="configBool(config.defaultThinking)"
                    :disabled="configSaving"
                    @click="toggleConfigBoolean('defaultThinking')"
                  >
                    <span class="knob" />
                  </button>
                </div>

                <div class="row">
                  <span class="rlabel">
                    {{ t('settings.defaultPlanMode') }}
                    <span class="hint">{{ t('settings.defaultPlanModeHint') }}</span>
                  </span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :class="{ on: configBool(config.defaultPlanMode) }"
                    :aria-checked="configBool(config.defaultPlanMode)"
                    :disabled="configSaving"
                    @click="toggleConfigBoolean('defaultPlanMode')"
                  >
                    <span class="knob" />
                  </button>
                </div>

                <div class="row">
                  <span class="rlabel">
                    {{ t('settings.mergeSkills') }}
                    <span class="hint">{{ t('settings.mergeSkillsHint') }}</span>
                  </span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :class="{ on: configBool(config.mergeAllAvailableSkills) }"
                    :aria-checked="configBool(config.mergeAllAvailableSkills)"
                    :disabled="configSaving"
                    @click="toggleConfigBoolean('mergeAllAvailableSkills')"
                  >
                    <span class="knob" />
                  </button>
                </div>

                <div v-if="config.telemetry !== undefined" class="row">
                  <span class="rlabel">{{ t('settings.telemetry') }}</span>
                  <button
                    type="button"
                    class="switch"
                    role="switch"
                    :class="{ on: configBool(config.telemetry) }"
                    :aria-checked="configBool(config.telemetry)"
                    :disabled="configSaving"
                    @click="toggleConfigBoolean('telemetry')"
                  >
                    <span class="knob" />
                  </button>
                </div>

                <div v-if="providerEntries.length > 0" class="provider-list">
                  <div v-for="{ id, provider } in providerEntries" :key="id" class="provider-row">
                    <div class="provider-main">
                      <span class="provider-id">{{ id }}</span>
                      <span class="provider-type">{{ provider.type }}</span>
                    </div>
                    <div class="provider-meta">
                      <span :class="['provider-badge', provider.hasApiKey ? 'ok' : 'warn']">
                        {{ provider.hasApiKey ? t('settings.credentialReady') : t('settings.credentialMissing') }}
                      </span>
                      <span v-if="provider.defaultModel" class="provider-model">{{ provider.defaultModel }}</span>
                    </div>
                  </div>
                </div>
              </template>

              <div v-else class="empty-config">
                {{ t('settings.configUnavailable') }}
              </div>
            </section>
          </section>

          <!-- Advanced -->
          <section
            v-show="activeTab === 'advanced'"
            :id="`settings-panel-advanced`"
            class="panel"
            role="tabpanel"
            aria-labelledby="settings-tab-advanced"
          >
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
          </section>

          <!-- Experimental -->
          <section
            v-show="activeTab === 'experimental'"
            :id="`settings-panel-experimental`"
            class="panel"
            role="tabpanel"
            aria-labelledby="settings-tab-experimental"
          >
            <section class="sec">
              <h3 class="sec-title">{{ t('settings.beta') }}</h3>
              <div class="row">
                <span class="rlabel">
                  {{ t('settings.betaToc') }}
                  <span class="hint">{{ t('settings.betaTocHint') }}</span>
                </span>
                <button
                  type="button"
                  class="switch"
                  role="switch"
                  :class="{ on: betaToc }"
                  :aria-checked="betaToc"
                  @click="emit('setBetaToc', !betaToc)"
                >
                  <span class="knob" />
                </button>
              </div>
            </section>
          </section>
        </div>
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
  width: min(720px, 100%);
  height: 640px;
  max-height: calc(100vh - 80px);
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
.dtitle { font-family: var(--sans); font-size: var(--ui-font-size-lg); font-weight: 600; color: var(--ink); }
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

.settings-layout {
  display: flex;
  flex-direction: row;
  min-height: 0;
  flex: 1;
}

.settings-tabs {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 140px;
  padding: 10px 8px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  gap: 2px;
  overflow-y: auto;
}
.tab {
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--sans);
  font-size: calc(var(--ui-font-size) - 0.5px);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.tab:hover { background: var(--soft); color: var(--ink); }
.tab.on { background: var(--soft); color: var(--blue2); font-weight: 600; }

.body { overflow-y: auto; padding: 6px 16px 16px; flex: 1; }
.panel { display: block; }
.sec { padding: 12px 0; border-bottom: 1px solid var(--line); }
.sec:last-child { border-bottom: none; }
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.sec-title {
  margin: 0 0 10px;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.sec-head .sec-title { margin-bottom: 0; }
.saving {
  flex: none;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
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
.rlabel { font-family: var(--sans); font-size: calc(var(--ui-font-size) - 0.5px); color: var(--ink); display: flex; flex-direction: column; gap: 2px; }
.rvalue { font-family: var(--sans); font-size: calc(var(--ui-font-size) - 1.5px); color: var(--muted); max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rvalue.mono { font-family: var(--mono); font-size: var(--ui-font-size-xs); }
.hint { font-size: calc(var(--ui-font-size) - 3px); color: var(--faint); font-family: var(--sans); }

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
  font-size: var(--ui-font-size-sm);
  text-align: right;
}
.num-unit {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
}

.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.opt {
  border: none;
  background: var(--bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 5px 12px;
  cursor: pointer;
  border-left: 1px solid var(--line);
}
.opt:first-child { border-left: none; }
.opt:hover { color: var(--ink); }
.opt.on { background: var(--soft); color: var(--blue2); font-weight: 600; }
.opt:disabled { opacity: 0.55; cursor: not-allowed; }

.select-field {
  min-width: 220px;
  max-width: min(320px, 50vw);
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: calc(var(--ui-font-size) - 1.5px);
  padding: 0 8px;
}
.select-field:disabled { opacity: 0.6; cursor: not-allowed; }

.empty-config {
  font-family: var(--sans);
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--muted);
  padding: 4px 0;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel2);
}
.provider-main,
.provider-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.provider-main { flex: 1; }
.provider-meta { flex: none; max-width: 45%; }
.provider-id,
.provider-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-id {
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: var(--ink);
}
.provider-type {
  flex: none;
  font-family: var(--mono);
  font-size: max(10px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
}
.provider-model {
  font-family: var(--mono);
  font-size: max(10px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
}
.provider-badge {
  flex: none;
  border-radius: 999px;
  padding: 2px 7px;
  font-family: var(--mono);
  font-size: max(10px, calc(var(--ui-font-size) - 4px));
}
.provider-badge.ok {
  background: color-mix(in srgb, var(--ok) 12%, var(--bg));
  color: var(--ok);
}
.provider-badge.warn {
  background: color-mix(in srgb, var(--warn) 12%, var(--bg));
  color: var(--warn);
}

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
  font-size: calc(var(--ui-font-size) - 1.5px);
  padding: 6px 12px;
  cursor: pointer;
}
.act:hover { background: var(--soft); border-color: var(--bd); }
.act.signin { background: var(--blue); color: var(--bg); border-color: var(--blue); }
.act.signin:hover { background: var(--blue2); }
.act.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 30%, var(--line)); }
.act.danger:hover { background: color-mix(in srgb, var(--err) 8%, var(--bg)); }

@media (max-width: 640px) {
  .backdrop {
    padding:
      max(12px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .dialog {
    max-height: calc(100dvh - 24px);
  }
  .settings-layout { flex-direction: column; }
  .settings-tabs {
    flex-direction: row;
    width: auto;
    border-right: none;
    border-bottom: 1px solid var(--line);
    padding: 8px 12px;
    gap: 6px;
    overflow-x: auto;
  }
  .tab { white-space: nowrap; }
  .row {
    align-items: flex-start;
    flex-direction: column;
  }
  .select-field {
    width: 100%;
    max-width: none;
  }
  .provider-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .provider-meta {
    max-width: 100%;
    flex-wrap: wrap;
  }
}
</style>
