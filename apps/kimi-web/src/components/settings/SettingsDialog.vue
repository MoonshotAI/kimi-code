<!-- apps/kimi-web/src/components/settings/SettingsDialog.vue -->
<!-- The app's dedicated Settings page (modal). Consolidates what used to be
     scattered in the sidebar account popover: appearance, language, account,
     connection, plus notifications and the troubleshooting-log export. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDialogFocus } from '../../composables/useDialogFocus';
import LanguageSwitcher from './LanguageSwitcher.vue';
import { serverEndpointLabel } from '../../api/config';
import { downloadTraceLog, isTraceEnabled } from '../../debug/trace';
import type { Accent, ColorScheme } from '../../composables/useKimiWebClient';
import type { AppConfig, AppModel } from '../../api/types';
import Dialog from '../ui/Dialog.vue';
import Switch from '../ui/Switch.vue';
import Button from '../ui/Button.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import Select from '../ui/Select.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const props = defineProps<{
  colorScheme: ColorScheme;
  accent: Accent;
  uiFontSize: number;
  authReady: boolean;
  accountModel?: string | null;
  /** Browser-notification-on-completion preference. */
  notify: boolean;
  /** Browser-notification-on-question (needs answer) preference. */
  notifyQuestion: boolean;
  /** OS permission state ('default' | 'granted' | 'denied') for the hint. */
  notifyPermission?: string;
  /** Play-a-sound-on-completion preference. */
  sound: boolean;
  /** Conversation outline (proportional bubbles, viewport indicator, hover tooltip). */
  conversationToc?: boolean;
  /** Global daemon config from GET /api/v1/config. Secrets are redacted server-side. */
  config?: AppConfig | null;
  /** Models from the daemon catalog, used to label default-model choices. */
  models?: AppModel[];
  /** True while POST /api/v1/config is saving. */
  configSaving?: boolean;
  /** Server version reported by GET /api/v1/meta. */
  serverVersion?: string;
}>();

const emit = defineEmits<{
  setColorScheme: [colorScheme: ColorScheme];
  setAccent: [accent: Accent];
  setUiFontSize: [size: number];
  setNotify: [on: boolean];
  setNotifyQuestion: [on: boolean];
  setSound: [on: boolean];
  setConversationToc: [on: boolean];
  login: [];
  logout: [];
  openOnboarding: [];
  openProviders: [];
  updateConfig: [patch: Partial<AppConfig>];
  close: [];
}>();

type SettingsTab = 'general' | 'agent' | 'account' | 'advanced';

const activeTab = ref<SettingsTab>('general');

const tabs: { id: SettingsTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tabs.general' },
  { id: 'agent', labelKey: 'settings.tabs.agent' },
  { id: 'account', labelKey: 'settings.tabs.account' },
  { id: 'advanced', labelKey: 'settings.tabs.advanced' },
];

const daemonEndpoint = serverEndpointLabel();
const permissionModes = ['manual', 'auto', 'yolo'] as const;
// Reuse the Composer's permission labels (status.permission*) so the
// default-permission names stay in sync with the toolbar.
const permissionLabelKey: Record<(typeof permissionModes)[number], string> = {
  manual: 'status.permissionManual',
  auto: 'status.permissionAuto',
  yolo: 'status.permissionYolo',
};

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

type ModelOption = { id: string; label: string; provider: string };

const modelOptions = computed<ModelOption[]>(() => {
  const byId = new Map<string, ModelOption>();
  for (const model of props.models ?? []) {
    byId.set(model.id, {
      id: model.id,
      label: model.displayName ?? model.model ?? model.id,
      provider: model.provider,
    });
  }
  for (const [id, raw] of Object.entries(props.config?.models ?? {})) {
    if (byId.has(id)) continue;
    const provider = extractConfigModelProvider(raw);
    byId.set(id, {
      id,
      label: formatConfigModelLabel(id, raw, provider),
      provider: provider ?? id,
    });
  }
  return Array.from(byId.values());
});

const modelGroups = computed<Array<{ provider: string; options: ModelOption[] }>>(() => {
  const map = new Map<string, ModelOption[]>();
  for (const option of modelOptions.value) {
    const list = map.get(option.provider) ?? [];
    list.push(option);
    map.set(option.provider, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }
  return Array.from(map.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([provider, options]) => ({ provider, options }));
});

const defaultPermissionMode = computed(() => {
  const mode = props.config?.defaultPermissionMode;
  return mode === 'auto' || mode === 'yolo' || mode === 'manual' ? mode : 'manual';
});

function extractConfigModelProvider(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const provider = typeof source['provider'] === 'string' ? source['provider'] : undefined;
  return provider;
}

function formatConfigModelLabel(id: string, raw: unknown, provider?: string): string {
  if (!raw || typeof raw !== 'object') return id;
  const source = raw as Record<string, unknown>;
  const model = typeof source['model'] === 'string' ? source['model'] : undefined;
  const resolvedProvider = provider ?? extractConfigModelProvider(raw);
  if (model && resolvedProvider) return `${id} (${resolvedProvider}/${model})`;
  if (model) return `${id} (${model})`;
  return id;
}

function configBool(value: boolean | undefined): boolean {
  return value === true;
}

function setDefaultModel(value: string): void {
  if (!value || value === props.config?.defaultModel) return;
  emit('updateConfig', { defaultModel: value });
}

function setDefaultPermissionMode(mode: 'manual' | 'auto' | 'yolo'): void {
  if (mode === defaultPermissionMode.value) return;
  emit('updateConfig', { defaultPermissionMode: mode });
}

function toggleConfigBoolean(key: 'defaultPlanMode' | 'mergeAllAvailableSkills'): void {
  const current = props.config?.[key];
  emit('updateConfig', { [key]: !configBool(current) } as Partial<AppConfig>);
}

// "Default thinking" lives at config.thinking.enabled on the daemon — the legacy
// top-level defaultThinking field was removed. Read/write it there so the toggle
// actually persists (the old field was silently stripped by the server).
//
// Mirror the core resolver: only enabled === false disables thinking, so a config
// with an effort but no enabled field still counts as on.
function thinkingEnabled(): boolean {
  const thinking = props.config?.thinking;
  if (!thinking || typeof thinking !== 'object') return false;
  return (thinking as { enabled?: boolean }).enabled !== false;
}

function toggleDefaultThinking(): void {
  emit('updateConfig', { thinking: { enabled: !thinkingEnabled() } } as Partial<AppConfig>);
}

// Telemetry is opt-out: undefined and `true` both mean enabled, only explicit
// `false` disables it. Toggle based on that effective state so an unset value
// (displayed as on) flips to `false` instead of writing a redundant `true`.
function toggleTelemetry(): void {
  const enabled = props.config?.telemetry !== false;
  emit('updateConfig', { telemetry: !enabled } as Partial<AppConfig>);
}

function setTab(tab: SettingsTab): void {
  activeTab.value = tab;
}
</script>

<template>
  <Dialog :open="true" :close-on-esc="false" :title="t('settings.title')" size="xl" height="fixed" :padded="false" @close="emit('close')">
    <div ref="dialogRef" class="sd">
      <nav class="settings-tabs" role="tablist" :aria-label="t('settings.title')">
        <button
          v-for="tb in tabs"
          :key="tb.id"
          type="button"
          class="tab"
          role="tab"
          :aria-selected="activeTab === tb.id"
          :class="{ on: activeTab === tb.id }"
          @click="setTab(tb.id)"
        >
          {{ t(tb.labelKey) }}
        </button>
      </nav>

      <div class="body">
        <!-- General: Appearance + Notifications -->
        <section v-show="activeTab === 'general'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.appearance') }}</h3>
            <div class="row">
              <span class="rlabel">{{ t('theme.colorSchemeLabel') }}</span>
              <SegmentedControl
                :model-value="colorScheme"
                :options="[
                  { value: 'light', label: t('theme.light') },
                  { value: 'dark', label: t('theme.dark') },
                  { value: 'system', label: t('theme.system') },
                ]"
                @update:model-value="emit('setColorScheme', $event as ColorScheme)"
              />
            </div>
            <div class="row">
              <span class="rlabel">{{ t('theme.accentLabel') }}</span>
              <SegmentedControl
                :model-value="accent"
                :options="[
                  { value: 'blue', label: t('theme.accentBlue') },
                  { value: 'mono', label: t('theme.accentBlack') },
                ]"
                @update:model-value="emit('setAccent', $event as Accent)"
              />
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
            <div class="row">
              <span class="rlabel">
                {{ t('settings.conversationToc') }}
                <span class="hint">{{ t('settings.conversationTocHint') }}</span>
              </span>
              <Switch
                :model-value="conversationToc ?? true"
                :label="t('settings.conversationToc')"
                @update:model-value="emit('setConversationToc', $event)"
              />
            </div>
          </section>

          <section class="sec">
            <h3 class="sec-title">{{ t('settings.notifications') }}</h3>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.notifyOnComplete') }}
                <span v-if="notifyPermission === 'denied'" class="hint">{{ t('settings.notifyDenied') }}</span>
              </span>
              <Switch
                :model-value="notify"
                :disabled="notifyPermission === 'denied'"
                :label="t('settings.notifyOnComplete')"
                @update:model-value="emit('setNotify', $event)"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.notifyOnQuestion') }}
                <span v-if="notifyPermission === 'denied'" class="hint">{{ t('settings.notifyDenied') }}</span>
              </span>
              <Switch
                :model-value="notifyQuestion"
                :disabled="notifyPermission === 'denied'"
                :label="t('settings.notifyOnQuestion')"
                @update:model-value="emit('setNotifyQuestion', $event)"
              />
            </div>
            <div class="row">
              <span class="rlabel">{{ t('settings.soundOnComplete') }}</span>
              <Switch
                :model-value="sound"
                :label="t('settings.soundOnComplete')"
                @update:model-value="emit('setSound', $event)"
              />
            </div>
          </section>
        </section>

        <!-- Account -->
        <section v-show="activeTab === 'account'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.account') }}</h3>
            <div class="row">
              <span class="rlabel">{{ authReady ? 'managed:kimi-code' : t('sidebar.notSignedIn') }}</span>
              <Tooltip :text="accountModel">
                <span v-if="authReady && accountModel" class="rvalue">{{ accountModel }}</span>
              </Tooltip>
            </div>
            <div class="actions">
              <Button variant="secondary" size="sm" @click="emit('openOnboarding'); emit('close')">{{ t('onboarding.reopen') }}</Button>
              <Button v-if="authReady" variant="danger-soft" size="sm" @click="emit('logout')">{{ t('sidebar.signOut') }}</Button>
              <Button v-else variant="primary" size="sm" @click="emit('login')">{{ t('sidebar.signIn') }}</Button>
            </div>
          </section>
        </section>

        <!-- Agent defaults -->
        <section v-show="activeTab === 'agent'" class="panel">
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
                <div v-if="modelGroups.length > 0" class="select-wrap">
                  <Select
                    :model-value="config.defaultModel ?? ''"
                    :disabled="configSaving"
                    :aria-label="t('settings.defaultModel')"
                    @update:model-value="setDefaultModel"
                  >
                    <option v-if="!config.defaultModel" value="" disabled>{{ t('settings.noDefaultModel') }}</option>
                    <optgroup v-for="group in modelGroups" :key="group.provider" :label="group.provider">
                      <option v-for="model in group.options" :key="model.id" :value="model.id">
                        {{ model.label }}
                      </option>
                    </optgroup>
                  </Select>
                </div>
                <span v-else class="rvalue mono">{{ config.defaultModel ?? t('settings.noDefaultModel') }}</span>
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultPermission') }}
                  <span class="hint">{{ t('settings.defaultPermissionHint') }}</span>
                </span>
                <SegmentedControl
                  :model-value="defaultPermissionMode"
                  :options="permissionModes.map((m) => ({ value: m, label: t(permissionLabelKey[m]) }))"
                  @update:model-value="setDefaultPermissionMode($event as 'manual' | 'auto' | 'yolo')"
                />
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultThinking') }}
                  <span class="hint">{{ t('settings.defaultThinkingHint') }}</span>
                </span>
                <Switch
                  :model-value="thinkingEnabled()"
                  :disabled="configSaving"
                  :label="t('settings.defaultThinking')"
                  @update:model-value="toggleDefaultThinking()"
                />
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.defaultPlanMode') }}
                  <span class="hint">{{ t('settings.defaultPlanModeHint') }}</span>
                </span>
                <Switch
                  :model-value="configBool(config.defaultPlanMode)"
                  :disabled="configSaving"
                  :label="t('settings.defaultPlanMode')"
                  @update:model-value="toggleConfigBoolean('defaultPlanMode')"
                />
              </div>

              <div class="row">
                <span class="rlabel">
                  {{ t('settings.mergeSkills') }}
                  <span class="hint">{{ t('settings.mergeSkillsHint') }}</span>
                </span>
                <Switch
                  :model-value="configBool(config.mergeAllAvailableSkills)"
                  :disabled="configSaving"
                  :label="t('settings.mergeSkills')"
                  @update:model-value="toggleConfigBoolean('mergeAllAvailableSkills')"
                />
              </div>
            </template>

            <div v-else class="empty-config">
              {{ t('settings.configUnavailable') }}
            </div>
          </section>
        </section>

        <!-- Advanced: diagnostics + data/privacy -->
        <section v-show="activeTab === 'advanced'" class="panel">
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.advanced') }}</h3>
            <div class="row">
              <span class="rlabel">{{ t('sidebar.daemon') }}</span>
              <span class="rvalue mono">{{ daemonEndpoint }}</span>
            </div>
            <div class="row">
              <span class="rlabel">{{ t('settings.serverVersion') }}</span>
              <span class="rvalue mono">{{ serverVersion || '-' }}</span>
            </div>
            <div v-if="config" class="row">
              <span class="rlabel">
                {{ t('settings.telemetry') }}
                <span class="hint">{{ t('settings.telemetryHint') }}</span>
                <span class="hint">{{ t('settings.telemetryRestartHint') }}</span>
              </span>
              <Switch
                :model-value="config.telemetry !== false"
                :disabled="configSaving"
                :label="t('settings.telemetry')"
                @update:model-value="toggleTelemetry()"
              />
            </div>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.exportLog') }}
                <span v-if="!isTraceEnabled()" class="hint">{{ t('settings.logHint') }}</span>
              </span>
              <Button variant="secondary" size="sm" @click="exportLog">{{ t('settings.exportLogBtn') }}</Button>
            </div>
          </section>
        </section>

      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.sd { display: flex; flex-direction: row; min-height: 0; height: 100%; }

.settings-tabs {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 148px;
  padding: var(--space-2);
  gap: 2px;
  overflow-y: auto;
}
.tab {
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.tab:hover { background: var(--color-surface-sunken); color: var(--color-text); }
.tab.on { background: var(--color-accent-soft); color: var(--color-accent); font-weight: var(--weight-medium); }
.tab:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.body { display: flex; flex-direction: column; overflow-y: auto; padding: var(--space-2) var(--space-5) var(--space-5) var(--space-6); flex: 1; min-width: 0; }
.panel { display: block; }
.sec { padding: var(--space-4) 0; border-bottom: 1px solid var(--color-line); }
.sec:last-child { border-bottom: none; }
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.sec-title {
  margin: 0 0 var(--space-3);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.sec-head .sec-title { margin-bottom: 0; }
.saving {
  flex: none;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 38px;
  padding: var(--space-1) 0;
}
.rlabel {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.rvalue {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rvalue.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.hint { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--color-text-faint); }

.num-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  padding: 0 var(--space-3);
  height: 38px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.num-field:hover { border-color: var(--color-line-strong); }
.num-field:focus-within { border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.num-input {
  width: 48px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-base);
  text-align: right;
}
.num-unit {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.select-wrap { min-width: 220px; max-width: min(320px, 50vw); flex: none; }

.empty-config {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text-muted);
  padding: var(--space-1) 0;
}

.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }

@media (max-width: 640px) {
  .sd { flex-direction: column; }
  .settings-tabs {
    flex-direction: row;
    width: auto;
    padding: var(--space-2) var(--space-3);
    gap: var(--space-1);
    overflow-x: auto;
  }
  .tab { white-space: nowrap; flex: none; }
  .row {
    align-items: flex-start;
    flex-direction: column;
  }
  .select-wrap {
    width: 100%;
    max-width: none;
  }
}
</style>
