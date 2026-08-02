<!-- apps/kimi-web/src/components/settings/SettingsDialog.vue -->
<!-- The app's dedicated Settings page (modal). Consolidates what used to be
     scattered in the sidebar account popover: appearance, language, account,
     connection, plus notifications and the troubleshooting-log export. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import type { AppSession } from '../../api/types';
import { useDialogFocus } from '../../composables/useDialogFocus';
import LanguageSwitcher from './LanguageSwitcher.vue';
import ProviderManager from './ProviderManager.vue';
import { serverEndpointLabel } from '../../api/config';
import { downloadTraceLog, isTraceEnabled } from '../../debug/trace';
import type { Accent, ColorScheme } from '../../composables/useKimiWebClient';
import type { AppConfig, AppModel, AppMcpServerConfig, AppMcpTransport, AppProvider } from '../../api/types';
import Dialog from '../ui/Dialog.vue';
import Switch from '../ui/Switch.vue';
import Button from '../ui/Button.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import Select from '../ui/Select.vue';
import Tooltip from '../ui/Tooltip.vue';
import Input from '../ui/Input.vue';

const { t } = useI18n();

const props = defineProps<{
  colorScheme: ColorScheme;
  accent: Accent;
  uiFontSize: number;
  authReady?: boolean;
  accountModel?: string | null;
  /** Browser-notification-on-completion preference. */
  notify: boolean;
  /** Browser-notification-on-question (needs answer) preference. */
  notifyQuestion: boolean;
  /** Browser-notification-on-approval preference. */
  notifyApproval: boolean;
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
  /** Backend engine generation from GET /api/v1/meta ('v1' legacy, 'v2' kap-server). */
  backend?: 'v1' | 'v2';
  /** Provider list for the Providers tab (embedded ProviderManager). */
  providers?: AppProvider[];
  /** True while providers are being fetched. */
  providersLoading?: boolean;
  /** True when providers could not be fetched (daemon 404 / unsupported). */
  providersUnavailable?: boolean;
}>();

const emit = defineEmits<{
  setColorScheme: [colorScheme: ColorScheme];
  setAccent: [accent: Accent];
  setUiFontSize: [size: number];
  setNotify: [on: boolean];
  setNotifyQuestion: [on: boolean];
  setNotifyApproval: [on: boolean];
  setSound: [on: boolean];
  setConversationToc: [on: boolean];
  login: [];
  logout: [];
  openOnboarding: [];
  openProviders: [];
  updateConfig: [patch: Partial<AppConfig>];
  addProvider: [input: { type: string; apiKey?: string; baseUrl?: string; defaultModel?: string }];
  updateProvider: [id: string, input: { type?: string; apiKey?: string; baseUrl?: string; defaultModel?: string }];
  refreshProvider: [id: string];
  deleteProvider: [id: string];
  close: [];
}>();

type SettingsTab = 'preferences' | 'agent' | 'providers' | 'mcp' | 'skills' | 'advanced' | 'archived';

const activeTab = ref<SettingsTab>('preferences');

const tabs: { id: SettingsTab; labelKey: string }[] = [
  { id: 'preferences', labelKey: 'settings.tabs.preferences' },
  { id: 'agent', labelKey: 'settings.tabs.agent' },
  { id: 'providers', labelKey: 'settings.tabs.providers' },
  { id: 'mcp', labelKey: 'settings.tabs.mcp' },
  { id: 'skills', labelKey: 'settings.tabs.skills' },
  { id: 'advanced', labelKey: 'settings.tabs.advanced' },
  { id: 'archived', labelKey: 'settings.tabs.archived' },
];

const daemonEndpoint = serverEndpointLabel();
const backendLabel = computed(() =>
  props.backend === 'v2' ? 'v2 (kap-server)' : 'v1 (server)',
);
const permissionModes = ['manual', 'yolo', 'auto'] as const;
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
// Mirror the core resolver: thinking is on unless explicitly disabled
// (enabled === false). An absent thinking section — or one with an effort but no
// enabled field — falls through to the model/default effort (on for
// thinking-capable models), so the toggle reflects that as on.
function thinkingEnabled(): boolean {
  const thinking = props.config?.thinking;
  if (!thinking || typeof thinking !== 'object') return true;
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

// ---------------------------------------------------------------------------
// Archived-sessions tab — its own list state (server-side `archived_only`
// filter), kept separate from the per-workspace active list. Search, workspace
// filter and sort all run client-side over the loaded pages. Restore goes
// through the composable so the sidebar list updates automatically.
// ---------------------------------------------------------------------------
const client = useKimiWebClient();

const archivedItems = ref<AppSession[]>([]);
const archivedLoading = ref(false);
const archivedLoaded = ref(false);
const archiveQuery = ref('');
const archiveWsFilter = ref<string>('all'); // 'all' | cwd
const archiveSort = ref<'archived-desc' | 'created-desc' | 'name-asc'>('archived-desc');

// Load every archived session once when the tab opens (no frontend pagination).
// Search, sort and the workspace filter then run client-side over the full set,
// so results are always global and there is no empty-page / cursor bookkeeping
// to get wrong. The user waits a moment on first open in exchange for simplicity.
const ARCHIVED_PAGE_SIZE = 100;

async function loadAllArchived(): Promise<void> {
  if (archivedLoading.value || archivedLoaded.value) return;
  archivedLoading.value = true;
  try {
    const all: AppSession[] = [];
    let beforeId: string | undefined;
    for (;;) {
      const page = await client.loadArchivedSessions({ beforeId, pageSize: ARCHIVED_PAGE_SIZE });
      all.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      const next = page.items.at(-1)?.id;
      if (next === undefined) break;
      beforeId = next;
    }
    archivedItems.value = all;
    archivedLoaded.value = true;
  } catch (err) {
    console.warn('loadAllArchived failed', err);
  } finally {
    archivedLoading.value = false;
  }
}

watch(activeTab, (tab) => {
  if (tab === 'archived' && !archivedLoaded.value) {
    void loadAllArchived();
  }
  if (
    tab === 'mcp' &&
    client.mcpServers.value === undefined &&
    !client.mcpServersLoading.value
  ) {
    void client.loadMcpServers();
  }
  if (
    tab === 'skills' &&
    client.userSkills.value === undefined &&
    !client.userSkillsLoading.value
  ) {
    void client.loadUserSkills();
  }
});

const archiveWorkspaces = computed<string[]>(() => {
  const set = new Set<string>();
  for (const s of archivedItems.value) set.add(s.cwd);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});

const filteredArchived = computed<AppSession[]>(() => {
  const q = archiveQuery.value.trim().toLowerCase();
  // Defensive invariant: this panel must only ever render archived sessions,
  // even if an older server ignores `archived_only` and falls back to the
  // default (unarchived) list. Filter again on the client.
  let rows = archivedItems.value.filter((s) => s.archived === true);
  if (archiveWsFilter.value !== 'all') {
    rows = rows.filter((s) => s.cwd === archiveWsFilter.value);
  }
  if (q) rows = rows.filter((s) => s.title.toLowerCase().includes(q));
  rows = rows.slice();
  if (archiveSort.value === 'archived-desc') {
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (archiveSort.value === 'created-desc') {
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else {
    rows.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  return rows;
});

const groupedArchived = computed<{ cwd: string; items: AppSession[] }[]>(() => {
  const map = new Map<string, AppSession[]>();
  for (const s of filteredArchived.value) {
    const list = map.get(s.cwd) ?? [];
    list.push(s);
    map.set(s.cwd, list);
  }
  return Array.from(map.entries()).map(([cwd, items]) => ({ cwd, items }));
});

async function onRestore(id: string): Promise<void> {
  const ok = await client.restoreSession(id);
  if (ok) {
    archivedItems.value = archivedItems.value.filter((s) => s.id !== id);
  }
}

function archiveTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Extensions tab — MCP server CRUD (user-level mcp.json via kap-server) +
// read-only skills directory (auto-discovered for the current session /
// workspace). MCP state and actions live on the shared client composable;
// only the edit form state is local to this dialog.
// ---------------------------------------------------------------------------
interface McpEnvRow { key: string; value: string }
interface McpFormState {
  mode: 'add' | 'edit';
  originalName: string;
  name: string;
  transport: AppMcpTransport;
  command: string;
  argsText: string;
  env: McpEnvRow[];
  url: string;
  headers: McpEnvRow[];
  enabled: boolean;
  toolTimeoutSec: string;
}

const mcpForm = ref<McpFormState | null>(null);
const mcpSaving = ref(false);
const mcpFormError = ref<string>('');

const mcpTransports: AppMcpTransport[] = ['stdio', 'http', 'sse'];

// JSONC 编辑模式：直接编辑完整 mcp.json 文本（含注释），保存时与当前 map 对比
// 后对差异项分别调用 upsert / delete。无后端改动，仅前端 diff。
type McpViewMode = 'list' | 'jsonc';
const mcpViewMode = ref<McpViewMode>('list');
const mcpJsoncText = ref<string>('');
const mcpJsoncError = ref<string>('');
const mcpJsoncSaving = ref<boolean>(false);

function startJsoncMode(): void {
  mcpJsoncText.value = serializeMcpServersAsJsonc(client.mcpServers.value ?? {});
  mcpJsoncError.value = '';
  mcpViewMode.value = 'jsonc';
  mcpForm.value = null;
}

function cancelJsoncMode(): void {
  mcpViewMode.value = 'list';
  mcpJsoncText.value = '';
  mcpJsoncError.value = '';
}

/** SegmentedControl 切换处理：进入 JSONC 模式时序列化当前 map，离开时丢弃草稿。 */
function toggleMcpViewMode(value: unknown): void {
  const mode = value as McpViewMode;
  if (mode === mcpViewMode.value) return;
  if (mode === 'jsonc') startJsoncMode();
  else cancelJsoncMode();
}

/** 把当前 MCP 服务器 map 序列化为带注释提示的 JSONC 文本。 */
function serializeMcpServersAsJsonc(map: Record<string, AppMcpServerConfig>): string {
  const ordered: Record<string, AppMcpServerConfig> = {};
  for (const name of Object.keys(map).sort()) {
    ordered[name] = stripUndefined(map[name]!);
  }
  const header = '// MCP 服务器配置（JSONC：支持 // 与 /* */ 注释、尾随逗号）\n'
    + '// transport: stdio | http | sse\n'
    + '// stdio: command / args / env / cwd\n'
    + '// http|sse: url / headers / bearerTokenEnvVar\n'
    + '// 通用: enabled / toolTimeoutMs / startupTimeoutMs / enabledTools / disabledTools\n';
  return header + JSON.stringify(ordered, null, 2);
}

function stripUndefined<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

/** 解析 JSONC 文本（容忍行注释、块注释、尾随逗号）。失败抛出 Error。 */
function parseJsonc(text: string): unknown {
  // 逐字符扫描，跳过字符串内的所有符号；仅在字符串外剥离注释与尾随逗号。
  let inString = false;
  let escape = false;
  let result = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      // 行注释：跳到行尾
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // 块注释：跳到 */
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  // 去除尾随逗号：仅匹配 } 或 ] 前的逗号（含中间空白）
  const cleaned = result.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

async function saveJsoncMode(): Promise<void> {
  mcpJsoncError.value = '';
  let parsed: unknown;
  try {
    parsed = parseJsonc(mcpJsoncText.value);
  } catch (err) {
    mcpJsoncError.value = err instanceof Error ? err.message : String(err);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    mcpJsoncError.value = t('settings.mcpJsoncNotObject');
    return;
  }
  const nextMap = parsed as Record<string, unknown>;
  const current = client.mcpServers.value ?? {};

  // 校验每个值必须是对象（结构不深校验，由后端兜底）
  for (const [name, value] of Object.entries(nextMap)) {
    if (!name.trim()) {
      mcpJsoncError.value = t('settings.mcpJsoncEmptyName');
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      mcpJsoncError.value = t('settings.mcpJsoncInvalidServer', { name });
      return;
    }
  }

  const nextNames = new Set(Object.keys(nextMap));
  const currentNames = new Set(Object.keys(current));

  mcpJsoncSaving.value = true;
  try {
    // 先处理删除（旧 name 不在新 map 中）
    for (const name of currentNames) {
      if (!nextNames.has(name)) {
        await client.deleteMcpServer(name);
      }
    }
    // 再处理 upsert（新 name 或内容变化）
    for (const [name, value] of Object.entries(nextMap)) {
      const newCfg = value as AppMcpServerConfig;
      const oldCfg = current[name];
      if (!oldCfg || !shallowEqualMcp(oldCfg, newCfg)) {
        await client.upsertMcpServer(name, newCfg);
      }
    }
    mcpViewMode.value = 'list';
    mcpJsoncText.value = '';
  } catch (err) {
    mcpJsoncError.value = err instanceof Error ? err.message : String(err);
  } finally {
    mcpJsoncSaving.value = false;
  }
}

/** 浅比较两个 MCP 配置是否一致（仅看顶层 key/value）。 */
function shallowEqualMcp(a: AppMcpServerConfig, b: AppMcpServerConfig): boolean {
  const aKeys = Object.keys(stripUndefined(a as Record<string, unknown>)).sort();
  const bKeys = Object.keys(stripUndefined(b as Record<string, unknown>)).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i]!;
    if (k !== bKeys[i]) return false;
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (typeof av === 'object' && av !== null && typeof bv === 'object' && bv !== null) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

const mcpServerEntries = computed<Array<{ name: string; config: AppMcpServerConfig }>>(() => {
  const map = client.mcpServers.value;
  if (!map) return [];
  return Object.entries(map)
    .map(([name, config]) => ({ name, config }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const mcpServersCount = computed<number>(() => Object.keys(client.mcpServers.value ?? {}).length);

function startAddMcp(): void {
  mcpForm.value = {
    mode: 'add',
    originalName: '',
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    env: [],
    url: '',
    headers: [],
    enabled: true,
    toolTimeoutSec: '',
  };
  mcpFormError.value = '';
}

function startEditMcp(name: string, config: AppMcpServerConfig): void {
  mcpForm.value = {
    mode: 'edit',
    originalName: name,
    name,
    transport: config.transport ?? 'stdio',
    command: config.command ?? '',
    argsText: (config.args ?? []).join('\n'),
    env: Object.entries(config.env ?? {}).map(([key, value]) => ({ key, value })),
    url: config.url ?? '',
    headers: Object.entries(config.headers ?? {}).map(([key, value]) => ({ key, value })),
    enabled: config.enabled !== false,
    toolTimeoutSec: config.toolTimeoutMs ? String(Math.round(config.toolTimeoutMs / 1000)) : '',
  };
  mcpFormError.value = '';
}

function cancelMcpForm(): void {
  mcpForm.value = null;
  mcpFormError.value = '';
}

function addMcpEnvRow(): void {
  mcpForm.value?.env.push({ key: '', value: '' });
}
function removeMcpEnvRow(i: number): void {
  mcpForm.value?.env.splice(i, 1);
}
function addMcpHeaderRow(): void {
  mcpForm.value?.headers.push({ key: '', value: '' });
}
function removeMcpHeaderRow(i: number): void {
  mcpForm.value?.headers.splice(i, 1);
}

async function saveMcpForm(): Promise<void> {
  const form = mcpForm.value;
  if (!form) return;
  const name = form.name.trim();
  if (!name) {
    mcpFormError.value = t('settings.mcpNameRequired');
    return;
  }
  const existing = client.mcpServers.value ?? {};
  if (form.mode === 'add' && existing[name]) {
    mcpFormError.value = t('settings.mcpNameExists');
    return;
  }
  if (form.mode === 'edit' && form.originalName !== name && existing[name]) {
    mcpFormError.value = t('settings.mcpNameExists');
    return;
  }

  const config: AppMcpServerConfig = {
    transport: form.transport,
    enabled: form.enabled,
  };
  if (form.transport === 'stdio') {
    if (form.command.trim()) config.command = form.command.trim();
    const args = form.argsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (args.length) config.args = args;
    const env: Record<string, string> = {};
    for (const row of form.env) {
      const k = row.key.trim();
      if (k) env[k] = row.value;
    }
    if (Object.keys(env).length) config.env = env;
  } else {
    if (form.url.trim()) config.url = form.url.trim();
    const headers: Record<string, string> = {};
    for (const row of form.headers) {
      const k = row.key.trim();
      if (k) headers[k] = row.value;
    }
    if (Object.keys(headers).length) config.headers = headers;
  }
  if (form.toolTimeoutSec.trim()) {
    const sec = Number(form.toolTimeoutSec);
    if (Number.isFinite(sec) && sec > 0) config.toolTimeoutMs = Math.round(sec * 1000);
  }

  mcpSaving.value = true;
  mcpFormError.value = '';
  try {
    // Rename: delete the old entry first, then upsert under the new name.
    if (form.mode === 'edit' && form.originalName !== name) {
      await client.deleteMcpServer(form.originalName);
    }
    const ok = await client.upsertMcpServer(name, config);
    if (ok) {
      mcpForm.value = null;
    } else {
      mcpFormError.value = t('settings.mcpLoadError');
    }
  } catch (err) {
    mcpFormError.value = err instanceof Error ? err.message : String(err);
  } finally {
    mcpSaving.value = false;
  }
}

async function removeMcp(name: string): Promise<void> {
  if (!window.confirm(t('settings.mcpDeleteConfirm'))) return;
  await client.deleteMcpServer(name);
}

function mcpTransportLabel(transport: AppMcpTransport | undefined): string {
  if (transport === 'http') return t('settings.mcpTransportHttp');
  if (transport === 'sse') return t('settings.mcpTransportSse');
  return t('settings.mcpTransportStdio');
}

// Skills directory — read-only listing grouped by source. client.skills is the
// computed that mirrors the active session's skills (or the workspace's before
// a session exists).
const skillGroups = computed<Array<{ source: string; label: string; items: Array<{ name: string; description: string }> }>>(() => {
  const groups = new Map<string, Array<{ name: string; description: string }>>();
  for (const skill of client.skills.value) {
    const list = groups.get(skill.source) ?? [];
    list.push({ name: skill.name, description: skill.description });
    groups.set(skill.source, list);
  }
  const order = ['builtin', 'project', 'plugin', 'user'];
  const result: Array<{ source: string; label: string; items: Array<{ name: string; description: string }> }> = [];
  for (const source of order) {
    const items = groups.get(source);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ source, label: skillSourceLabel(source), items });
  }
  // Any unknown sources, appended after the known ones.
  for (const [source, items] of groups) {
    if (order.includes(source)) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ source, label: skillSourceLabel(source), items });
  }
  return result;
});

function skillSourceLabel(source: string): string {
  if (source === 'builtin') return t('settings.skillsSourceBuiltin');
  if (source === 'project') return t('settings.skillsSourceProject');
  if (source === 'plugin') return t('settings.skillsSourcePlugin');
  if (source === 'user') return t('settings.skillSourceUser');
  return source;
}

const skillsCount = computed<number>(() => client.skills.value.length);

// 用户技能目录管理（extraSkillDirs 配置项 CRUD）。后端没有 user skills 写入 API，
// 但有 extra_skill_dirs 配置项 —— 用户添加的目录会被 daemon 自动扫描，等价于
// "增加一组用户技能"。这是当前能在前端持久化且真正生效的最小可用方案。
const skillDirList = computed<string[]>(() => props.config?.extraSkillDirs ?? []);
const skillDirEditing = ref<boolean>(false);
const skillDirDraft = ref<string[]>([]);
const skillDirNewPath = ref<string>('');
const skillDirError = ref<string>('');

function startEditSkillDirs(): void {
  skillDirDraft.value = [...skillDirList.value];
  skillDirNewPath.value = '';
  skillDirError.value = '';
  skillDirEditing.value = true;
}

function cancelEditSkillDirs(): void {
  skillDirEditing.value = false;
  skillDirDraft.value = [];
  skillDirNewPath.value = '';
  skillDirError.value = '';
}

function skillDirAdd(): void {
  const path = skillDirNewPath.value.trim();
  if (!path) {
    skillDirError.value = t('settings.skillDirEmptyPath');
    return;
  }
  if (skillDirDraft.value.includes(path)) {
    skillDirError.value = t('settings.skillDirDuplicate');
    return;
  }
  skillDirDraft.value = [...skillDirDraft.value, path];
  skillDirNewPath.value = '';
  skillDirError.value = '';
}

function skillDirRemove(idx: number): void {
  skillDirDraft.value = skillDirDraft.value.filter((_, i) => i !== idx);
}

function skillDirMove(idx: number, direction: -1 | 1): void {
  const next = idx + direction;
  if (next < 0 || next >= skillDirDraft.value.length) return;
  const arr = [...skillDirDraft.value];
  const tmp = arr[idx]!;
  arr[idx] = arr[next]!;
  arr[next] = tmp;
  skillDirDraft.value = arr;
}

function saveSkillDirs(): void {
  const trimmed = skillDirDraft.value.map((p) => p.trim()).filter((p) => p.length > 0);
  emit('updateConfig', { extraSkillDirs: trimmed });
  cancelEditSkillDirs();
}

function removeSkillDirImmediate(path: string): void {
  const next = skillDirList.value.filter((p) => p !== path);
  emit('updateConfig', { extraSkillDirs: next });
}

// 用户自定义技能（<kimi-home>/skills/<name>/SKILL.md）的增删改。后端 REST
// 路由已就绪：GET/POST/DELETE /api/v1/skills。这里维护一个内联表单状态：
// skillFormMode = 'idle' | 'create' | 'edit'，编辑态记录 originalName 以便
// 改名（先删旧再建新，因为后端 upsert 以 name 为键）。
type SkillFormMode = 'idle' | 'create' | 'edit';
const skillFormMode = ref<SkillFormMode>('idle');
const skillFormOriginalName = ref<string>('');
const skillFormName = ref<string>('');
const skillFormDescription = ref<string>('');
const skillFormContent = ref<string>('');
const skillFormError = ref<string>('');
const skillFormSaving = ref<boolean>(false);

function startCreateUserSkill(): void {
  skillFormMode.value = 'create';
  skillFormOriginalName.value = '';
  skillFormName.value = '';
  skillFormDescription.value = '';
  skillFormContent.value = '';
  skillFormError.value = '';
}

function startEditUserSkill(skill: { name: string; description: string; content: string }): void {
  skillFormMode.value = 'edit';
  skillFormOriginalName.value = skill.name;
  skillFormName.value = skill.name;
  skillFormDescription.value = skill.description;
  skillFormContent.value = skill.content;
  skillFormError.value = '';
}

function cancelUserSkillForm(): void {
  skillFormMode.value = 'idle';
  skillFormOriginalName.value = '';
  skillFormName.value = '';
  skillFormDescription.value = '';
  skillFormContent.value = '';
  skillFormError.value = '';
}

async function saveUserSkillForm(): Promise<void> {
  const name = skillFormName.value.trim();
  if (!name) {
    skillFormError.value = t('settings.skillEmptyName');
    return;
  }
  // 同名校验：编辑态下若未改名则跳过；改名或新建时检查是否已存在同名技能。
  const existing = client.userSkills.value ?? [];
  const isRename = skillFormMode.value === 'edit' && name !== skillFormOriginalName.value;
  if (skillFormMode.value === 'create' || isRename) {
    if (existing.some((s) => s.name === name)) {
      skillFormError.value = t('settings.skillDuplicateName');
      return;
    }
  }
  skillFormSaving.value = true;
  skillFormError.value = '';
  try {
    // 改名场景：后端 upsert 以 name 为键，无法原地改名，需先删旧再建新。
    if (isRename) {
      const deleted = await client.deleteUserSkill(skillFormOriginalName.value);
      if (!deleted) {
        skillFormError.value = t('settings.skillSaving');
        return;
      }
    }
    const ok = await client.upsertUserSkill(name, {
      description: skillFormDescription.value.trim(),
      content: skillFormContent.value,
    });
    if (!ok) {
      skillFormError.value = t('settings.skillSaving');
      return;
    }
    cancelUserSkillForm();
  } finally {
    skillFormSaving.value = false;
  }
}

async function removeUserSkill(name: string): Promise<void> {
  await client.deleteUserSkill(name);
}

function reloadUserSkills(): void {
  void client.loadUserSkills();
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
        <section v-show="activeTab === 'preferences'" class="panel">
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
              <span class="rlabel">
                {{ t('settings.notifyOnApproval') }}
                <span v-if="notifyPermission === 'denied'" class="hint">{{ t('settings.notifyDenied') }}</span>
              </span>
              <Switch
                :model-value="notifyApproval"
                :disabled="notifyPermission === 'denied'"
                :label="t('settings.notifyOnApproval')"
                @update:model-value="emit('setNotifyApproval', $event)"
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

          <!-- Onboarding / 引导 -->
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.onboardingSection') }}</h3>
            <div class="row">
              <span class="rlabel">
                {{ t('settings.onboardingSection') }}
                <span class="hint">{{ t('settings.onboardingHint') }}</span>
              </span>
              <Button variant="secondary" size="sm" @click="emit('openOnboarding'); emit('close')">{{ t('onboarding.reopen') }}</Button>
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

        <!-- Providers (embedded ProviderManager — list / add / edit / refresh / delete) -->
        <section v-show="activeTab === 'providers'" class="panel">
          <div class="panel-head">
            <div class="panel-kicker">{{ t('settings.tabs.providers') }}</div>
            <h4 class="panel-title">
              {{ t('settings.providers') }}
              <span class="ext-count">{{ (providers ?? []).length }}</span>
            </h4>
            <p class="panel-desc">{{ t('settings.providersHint') }}</p>
          </div>
          <ProviderManager
            embedded
            :providers="providers ?? []"
            :loading="providersLoading"
            :unavailable="providersUnavailable"
            @add="emit('addProvider', $event)"
            @update="(id, input) => emit('updateProvider', id, input)"
            @refresh="emit('refreshProvider', $event)"
            @delete="emit('deleteProvider', $event)"
          />
        </section>

        <!-- MCP servers (CRUD against user-level mcp.json) -->
        <section v-show="activeTab === 'mcp'" class="panel">
          <div class="panel-head">
            <div class="panel-kicker">{{ t('settings.tabs.mcp') }}</div>
            <h4 class="panel-title">
              {{ t('settings.mcpTitle') }}
              <span class="ext-count">{{ t('settings.mcpServersCount', { count: mcpServersCount }) }}</span>
            </h4>
            <p class="panel-desc">{{ t('settings.mcpDesc') }}</p>
            <div class="panel-head-actions">
              <SegmentedControl
                :model-value="mcpViewMode"
                :options="[
                  { value: 'list', label: t('settings.mcpViewList') },
                  { value: 'jsonc', label: t('settings.mcpViewJsonc') },
                ]"
                :disabled="client.mcpServers.value === undefined || mcpForm !== null || mcpJsoncSaving"
                @update:model-value="toggleMcpViewMode"
              />
            </div>
          </div>

          <!-- JSONC 编辑模式 -->
          <section v-if="mcpViewMode === 'jsonc'" class="sec">
            <p class="ext-form-hint">{{ t('settings.mcpJsoncHint') }}</p>
            <textarea
              v-model="mcpJsoncText"
              class="ext-textarea ext-jsonc-textarea"
              rows="20"
              spellcheck="false"
              :aria-label="t('settings.mcpViewJsonc')"
            ></textarea>
            <div v-if="mcpJsoncError" class="ext-error ext-form-error">{{ mcpJsoncError }}</div>
            <div class="ext-form-actions">
              <Button variant="secondary" size="sm" :disabled="mcpJsoncSaving" @click="cancelJsoncMode">{{ t('settings.mcpCancelBtn') }}</Button>
              <Button variant="primary" size="sm" :disabled="mcpJsoncSaving" @click="saveJsoncMode">{{ mcpJsoncSaving ? t('settings.mcpSaving') : t('settings.mcpSaveBtn') }}</Button>
            </div>
          </section>

          <!-- 列表模式（默认） -->
          <section v-else class="sec">
            <!-- Load error banner -->
            <div v-if="client.mcpServersLoadError.value" class="ext-error">
              {{ t('settings.mcpLoadError') }}
            </div>

            <!-- Loading skeleton -->
            <div v-if="client.mcpServersLoading.value && client.mcpServers.value === undefined" class="archive-empty">
              {{ t('settings.archivedLoading') }}
            </div>

            <!-- Server list -->
            <template v-else>
              <div v-if="mcpServerEntries.length > 0" class="ext-list">
                <div v-for="entry in mcpServerEntries" :key="entry.name" class="ext-card">
                  <div class="ext-card-head">
                    <div class="ext-card-name">
                      <span class="ext-name">{{ entry.name }}</span>
                      <span class="ext-badge">{{ mcpTransportLabel(entry.config.transport) }}</span>
                      <span v-if="entry.config.enabled === false" class="ext-badge ext-badge-muted">{{ t('settings.mcpEnabled') }}: off</span>
                    </div>
                    <div class="ext-card-actions">
                      <Button variant="secondary" size="sm" :disabled="mcpForm !== null" @click="startEditMcp(entry.name, entry.config)">{{ t('settings.mcpEditBtn') }}</Button>
                      <Button variant="danger-soft" size="sm" :disabled="mcpForm !== null" @click="removeMcp(entry.name)">{{ t('settings.mcpDeleteBtn') }}</Button>
                    </div>
                  </div>
                  <div class="ext-card-body">
                    <template v-if="entry.config.transport === 'http' || entry.config.transport === 'sse'">
                      <div class="ext-field"><span class="ext-field-label">{{ t('settings.mcpUrl') }}</span><span class="ext-field-value mono">{{ entry.config.url || '—' }}</span></div>
                    </template>
                    <template v-else>
                      <div class="ext-field"><span class="ext-field-label">{{ t('settings.mcpCommand') }}</span><span class="ext-field-value mono">{{ entry.config.command || '—' }}</span></div>
                      <div v-if="entry.config.args && entry.config.args.length" class="ext-field"><span class="ext-field-label">{{ t('settings.mcpArgs') }}</span><span class="ext-field-value mono">{{ entry.config.args.join(' ') }}</span></div>
                    </template>
                  </div>
                </div>
              </div>
              <div v-else-if="!mcpForm" class="archive-empty">
                {{ t('settings.mcpNoServers') }}
              </div>
            </template>

            <!-- Add button (hidden while editing) -->
            <div v-if="!mcpForm" class="ext-add-row">
              <Button variant="primary" size="sm" :disabled="client.mcpServers.value === undefined" @click="startAddMcp">{{ t('settings.mcpAddBtn') }}</Button>
            </div>

            <!-- Inline add/edit form -->
            <div v-if="mcpForm" class="ext-form">
              <div class="ext-form-head">
                <span class="ext-form-title">{{ mcpForm.mode === 'add' ? t('settings.mcpAddBtn') : t('settings.mcpServerForm') }}</span>
              </div>

              <div class="ext-form-row">
                <label class="ext-field-label">{{ t('settings.mcpServerName') }}</label>
                <input v-model="mcpForm.name" class="ext-input" :placeholder="t('settings.mcpAddPlaceholder')" :aria-label="t('settings.mcpServerName')" />
              </div>

              <div class="ext-form-row">
                <label class="ext-field-label">{{ t('settings.mcpTransport') }}</label>
                <SegmentedControl
                  :model-value="mcpForm.transport"
                  :options="mcpTransports.map((tr) => ({ value: tr, label: t('settings.mcpTransport' + (tr === 'stdio' ? 'Stdio' : tr === 'http' ? 'Http' : 'Sse')) }))"
                  @update:model-value="mcpForm!.transport = $event as AppMcpTransport"
                />
              </div>
              <div class="ext-form-hint">{{ t('settings.mcpTransportHint') }}</div>

              <!-- stdio fields -->
              <template v-if="mcpForm.transport === 'stdio'">
                <div class="ext-form-row">
                  <label class="ext-field-label">{{ t('settings.mcpCommand') }}</label>
                  <input v-model="mcpForm.command" class="ext-input" :placeholder="t('settings.mcpCommandPlaceholder')" :aria-label="t('settings.mcpCommand')" />
                </div>
                <div class="ext-form-row ext-form-row-stack">
                  <label class="ext-field-label">{{ t('settings.mcpArgs') }}</label>
                  <textarea v-model="mcpForm.argsText" class="ext-textarea" rows="3" :placeholder="t('settings.mcpArgPlaceholder')" :aria-label="t('settings.mcpArgs')"></textarea>
                  <span class="ext-form-hint">{{ t('settings.mcpArgsHint') }}</span>
                </div>
                <div class="ext-form-row ext-form-row-stack">
                  <div class="ext-kv-head">
                    <label class="ext-field-label">{{ t('settings.mcpEnv') }}</label>
                    <Button variant="ghost" size="sm" @click="addMcpEnvRow">{{ t('settings.mcpAddEnv') }}</Button>
                  </div>
                  <div v-if="mcpForm.env.length === 0" class="ext-form-hint">{{ t('settings.mcpEnvHint') }}</div>
                  <div v-for="(row, i) in mcpForm.env" :key="i" class="ext-kv-row">
                    <input v-model="row.key" class="ext-input ext-kv-key" :placeholder="t('settings.mcpEnvKey')" :aria-label="t('settings.mcpEnvKey')" />
                    <input v-model="row.value" class="ext-input ext-kv-value" :placeholder="t('settings.mcpEnvValue')" :aria-label="t('settings.mcpEnvValue')" />
                    <Button variant="ghost" size="sm" @click="removeMcpEnvRow(i)">×</Button>
                  </div>
                </div>
              </template>

              <!-- http / sse fields -->
              <template v-else>
                <div class="ext-form-row">
                  <label class="ext-field-label">{{ t('settings.mcpUrl') }}</label>
                  <input v-model="mcpForm.url" class="ext-input" :placeholder="t('settings.mcpUrlPlaceholder')" :aria-label="t('settings.mcpUrl')" />
                </div>
                <div class="ext-form-row ext-form-row-stack">
                  <div class="ext-kv-head">
                    <label class="ext-field-label">{{ t('settings.mcpHeaders') }}</label>
                    <Button variant="ghost" size="sm" @click="addMcpHeaderRow">{{ t('settings.mcpAddHeader') }}</Button>
                  </div>
                  <div v-if="mcpForm.headers.length === 0" class="ext-form-hint">{{ t('settings.mcpHeadersHint') }}</div>
                  <div v-for="(row, i) in mcpForm.headers" :key="i" class="ext-kv-row">
                    <input v-model="row.key" class="ext-input ext-kv-key" :placeholder="t('settings.mcpHeaderKey')" :aria-label="t('settings.mcpHeaderKey')" />
                    <input v-model="row.value" class="ext-input ext-kv-value" :placeholder="t('settings.mcpHeaderValue')" :aria-label="t('settings.mcpHeaderValue')" />
                    <Button variant="ghost" size="sm" @click="removeMcpHeaderRow(i)">×</Button>
                  </div>
                </div>
              </template>

              <!-- common fields -->
              <div class="ext-form-row">
                <label class="ext-field-label">{{ t('settings.mcpToolTimeout') }}</label>
                <input v-model="mcpForm.toolTimeoutSec" class="ext-input ext-input-num" type="number" min="0" step="1" :placeholder="''" :aria-label="t('settings.mcpToolTimeout')" />
                <span class="ext-form-hint">{{ t('settings.mcpToolTimeoutHint') }}</span>
              </div>

              <div class="ext-form-row">
                <label class="ext-field-label">{{ t('settings.mcpEnabled') }}</label>
                <Switch :model-value="mcpForm.enabled" :label="t('settings.mcpEnabled')" @update:model-value="mcpForm!.enabled = $event" />
              </div>

              <div v-if="mcpFormError" class="ext-error ext-form-error">{{ mcpFormError }}</div>

              <div class="ext-form-actions">
                <Button variant="secondary" size="sm" :disabled="mcpSaving" @click="cancelMcpForm">{{ t('settings.mcpCancelBtn') }}</Button>
                <Button variant="primary" size="sm" :disabled="mcpSaving" @click="saveMcpForm">{{ mcpSaving ? t('settings.mcpSaving') : t('settings.mcpSaveBtn') }}</Button>
              </div>
            </div>
          </section>
        </section>

        <!-- Skills directory (auto-discovered, read-only listing) + 用户技能目录 CRUD -->
        <section v-show="activeTab === 'skills'" class="panel">
          <div class="panel-head">
            <div class="panel-kicker">{{ t('settings.tabs.skills') }}</div>
            <h4 class="panel-title">
              {{ t('settings.skillsTitle') }}
              <span class="ext-count">{{ t('settings.skillsCount', { count: skillsCount }) }}</span>
            </h4>
            <p class="panel-desc">{{ t('settings.skillsDesc') }}</p>
          </div>

          <!-- 用户自定义技能（单个技能 CRUD） -->
          <section class="sec">
            <div class="sec-head-row">
              <h3 class="sec-title">{{ t('settings.skillUserSkills') }}</h3>
              <div v-if="skillFormMode === 'idle'" class="sec-head-actions">
                <Button variant="secondary" size="sm" :disabled="client.userSkillsLoading.value" @click="reloadUserSkills">{{ t('settings.skillRefreshBtn') }}</Button>
                <Button variant="primary" size="sm" @click="startCreateUserSkill">{{ t('settings.skillCreateBtn') }}</Button>
              </div>
            </div>

            <div v-if="client.userSkillsLoading.value && client.userSkills.value === undefined" class="archive-empty">
              {{ t('settings.archivedLoading') }}
            </div>
            <div v-else-if="client.userSkillsError.value" class="archive-empty">
              {{ t('settings.skillsLoadFailed') }}
              <Button variant="secondary" size="sm" @click="reloadUserSkills">{{ t('settings.skillRefreshBtn') }}</Button>
            </div>

            <template v-else>
              <!-- 技能列表 -->
              <div v-if="(client.userSkills.value ?? []).length > 0" class="ext-list">
                <div v-for="skill in client.userSkills.value" :key="skill.name" class="ext-card">
                  <div class="ext-card-head">
                    <div class="ext-card-name">
                      <span class="ext-name mono">{{ skill.name }}</span>
                      <span v-if="skill.description" class="ext-skill-desc">{{ skill.description }}</span>
                    </div>
                    <div class="ext-card-actions">
                      <Button variant="secondary" size="sm" :disabled="skillFormMode !== 'idle'" @click="startEditUserSkill(skill)">{{ t('settings.skillEditBtn') }}</Button>
                      <Button variant="danger-soft" size="sm" :disabled="skillFormMode !== 'idle'" @click="removeUserSkill(skill.name)">{{ t('settings.skillDeleteBtn') }}</Button>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else-if="skillFormMode === 'idle'" class="archive-empty">{{ t('settings.skillNoUserSkills') }}</div>

              <!-- 新增/编辑表单 -->
              <div v-if="skillFormMode !== 'idle'" class="ext-form ext-user-skill-form">
                <div class="ext-form-row">
                  <label class="ext-field-label">{{ t('settings.skillNameLabel') }}</label>
                  <Input
                    v-model="skillFormName"
                    :placeholder="t('settings.skillNamePlaceholder')"
                  />
                </div>
                <div class="ext-form-row">
                  <label class="ext-field-label">{{ t('settings.skillDesc') }}</label>
                  <Input
                    v-model="skillFormDescription"
                    :placeholder="t('settings.skillDescPlaceholder')"
                  />
                </div>
                <div class="ext-form-row ext-form-row-stack">
                  <label class="ext-field-label">{{ t('settings.skillContentLabel') }}</label>
                  <textarea
                    v-model="skillFormContent"
                    class="ext-textarea"
                    rows="8"
                    :placeholder="t('settings.skillContentPlaceholder')"
                  />
                </div>
                <div v-if="skillFormError" class="ext-error ext-form-error">{{ skillFormError }}</div>
                <div class="ext-form-actions">
                  <Button variant="secondary" size="sm" :disabled="skillFormSaving" @click="cancelUserSkillForm">{{ t('settings.skillCancelBtn') }}</Button>
                  <Button variant="primary" size="sm" :disabled="skillFormSaving" @click="saveUserSkillForm">{{ skillFormSaving ? t('settings.skillSaving') : t('settings.skillSaveBtn') }}</Button>
                </div>
              </div>
            </template>
          </section>

          <!-- 用户技能目录（extraSkillDirs）：增删改 -->
          <section class="sec">
            <div class="sec-head-row">
              <h3 class="sec-title">{{ t('settings.skillExtDirs') }}</h3>
              <div v-if="!skillDirEditing" class="sec-head-actions">
                <Button variant="primary" size="sm" @click="startEditSkillDirs">{{ t('settings.skillDirEditBtn') }}</Button>
              </div>
            </div>
            <p class="ext-form-hint">{{ t('settings.skillDirHint') }}</p>

            <!-- 只读列表 -->
            <template v-if="!skillDirEditing">
              <div v-if="skillDirList.length > 0" class="ext-list">
                <div v-for="dir in skillDirList" :key="dir" class="ext-card">
                  <div class="ext-card-head">
                    <div class="ext-card-name">
                      <span class="ext-name mono ext-skill-dir-path">{{ dir }}</span>
                    </div>
                    <div class="ext-card-actions">
                      <Button variant="danger-soft" size="sm" @click="removeSkillDirImmediate(dir)">{{ t('settings.skillDirDeleteBtn') }}</Button>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="archive-empty">{{ t('settings.skillNoExtDirs') }}</div>
            </template>

            <!-- 编辑模式：可增删改 + 排序 -->
            <template v-else>
              <div v-if="skillDirDraft.length > 0" class="ext-list">
                <div v-for="(dir, idx) in skillDirDraft" :key="idx" class="ext-card ext-card-row">
                  <div class="ext-card-head">
                    <div class="ext-card-name ext-card-name-grow">
                      <span class="ext-skill-dir-index">{{ idx + 1 }}.</span>
                      <span class="ext-name mono ext-skill-dir-path">{{ dir }}</span>
                    </div>
                    <div class="ext-card-actions">
                      <Button variant="secondary" size="sm" :disabled="idx === 0" @click="skillDirMove(idx, -1)">↑</Button>
                      <Button variant="secondary" size="sm" :disabled="idx === skillDirDraft.length - 1" @click="skillDirMove(idx, 1)">↓</Button>
                      <Button variant="danger-soft" size="sm" @click="skillDirRemove(idx)">{{ t('settings.skillDirDeleteBtn') }}</Button>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="archive-empty">{{ t('settings.skillNoExtDirs') }}</div>

              <!-- 添加新目录 -->
              <div class="ext-add-row ext-add-row-inline">
                <Input
                  v-model="skillDirNewPath"
                  class="ext-add-input"
                  :placeholder="t('settings.skillAddPlaceholder')"
                />
                <Button variant="secondary" size="sm" @click="skillDirAdd">{{ t('settings.skillDirAddBtn') }}</Button>
              </div>
              <div v-if="skillDirError" class="ext-error ext-form-error">{{ skillDirError }}</div>

              <div class="ext-form-actions">
                <Button variant="secondary" size="sm" @click="cancelEditSkillDirs">{{ t('settings.skillDirCancelBtn') }}</Button>
                <Button variant="primary" size="sm" @click="saveSkillDirs">{{ t('settings.skillDirSaveBtn') }}</Button>
              </div>
            </template>
          </section>

          <!-- 自动发现的技能（按来源分组，只读，单行显示） -->
          <section class="sec">
            <h3 class="sec-title">{{ t('settings.skillsAutoDiscovered') }}</h3>
            <p class="ext-form-hint ext-skills-hint">{{ t('settings.skillsLoadHint') }}</p>

            <div v-if="skillGroups.length === 0" class="archive-empty">{{ t('settings.skillsEmpty') }}</div>
            <div v-else class="ext-list">
              <div v-for="g in skillGroups" :key="g.source" class="ext-card">
                <div class="ext-card-head">
                  <div class="ext-card-name">
                    <span class="ext-name">{{ g.label }}</span>
                    <span class="ext-badge ext-badge-muted">{{ g.items.length }}</span>
                  </div>
                </div>
                <div class="ext-card-body">
                  <div v-for="item in g.items" :key="item.name" class="ext-skill-row" :title="item.description">
                    <span class="ext-skill-name mono">{{ item.name }}</span>
                    <span v-if="item.description" class="ext-skill-desc">{{ item.description }}</span>
                  </div>
                </div>
              </div>
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
              <span class="rlabel">{{ t('settings.backend') }}</span>
              <span class="rvalue mono">{{ backendLabel }}</span>
            </div>
            <div class="row">
              <span class="rlabel">{{ t('settings.serverVersion') }}</span>
              <span class="rvalue mono">{{ serverVersion || '-' }}</span>
            </div>
            <div class="row">
              <span class="rlabel">{{ t('settings.account') }}</span>
              <Tooltip :text="accountModel || ''">
                <span class="rvalue">{{ authReady ? (accountModel || 'managed:kimi-code') : t('sidebar.notSignedIn') }}</span>
              </Tooltip>
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

        <!-- Archived sessions -->
        <section v-show="activeTab === 'archived'" class="panel">
          <div class="panel-head">
            <div class="panel-kicker">Archived sessions</div>
            <h4 class="panel-title">{{ t('settings.archivedTitle') }}</h4>
            <p class="panel-desc">{{ t('settings.archivedDesc') }}</p>
          </div>

          <div class="archive-toolbar">
            <label class="archive-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input v-model="archiveQuery" :placeholder="t('settings.archivedSearch')" />
            </label>
            <Select
              :model-value="archiveWsFilter"
              size="sm"
              :aria-label="t('settings.archivedAllWorkspaces')"
              @update:model-value="archiveWsFilter = $event as string"
            >
              <option value="all">{{ t('settings.archivedAllWorkspaces') }}</option>
              <option v-for="ws in archiveWorkspaces" :key="ws" :value="ws">{{ ws }}</option>
            </Select>
            <SegmentedControl
              size="sm"
              :model-value="archiveSort"
              :options="[
                { value: 'archived-desc', label: t('settings.archivedSortArchived') },
                { value: 'created-desc', label: t('settings.archivedSortCreated') },
                { value: 'name-asc', label: t('settings.archivedSortName') },
              ]"
              @update:model-value="archiveSort = $event as 'archived-desc' | 'created-desc' | 'name-asc'"
            />
          </div>

          <div v-if="archivedLoading" class="archive-empty">
            {{ t('settings.archivedLoadingAll') }}
          </div>

          <template v-else>
            <div v-if="groupedArchived.length > 0" class="archive-list">
              <section v-for="g in groupedArchived" :key="g.cwd" class="archive-card">
                <div class="archive-workspace">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v9H3z" /><path d="M3 7V5h6l2 2" /></svg>
                  <span class="path">{{ g.cwd }}</span>
                  <span class="count">{{ t('settings.archivedSessionsCount', { count: g.items.length }) }}</span>
                </div>
                <div class="setting-card">
                  <div v-for="s in g.items" :key="s.id" class="archive-row">
                    <div class="archive-meta">
                      <div class="archive-name">{{ s.title }}</div>
                      <div class="archive-time">{{ t('settings.archivedAt', { time: archiveTime(s.updatedAt) }) }}</div>
                    </div>
                    <Button variant="secondary" size="sm" @click="onRestore(s.id)">{{ t('settings.archivedRestore') }}</Button>
                  </div>
                </div>
              </section>
            </div>
            <div v-else class="archive-empty">
              {{ archivedItems.length === 0 ? t('settings.archivedEmpty') : t('settings.archivedNoMatch') }}
            </div>
          </template>
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
/* Archived-sessions tab */
.setting-card { border: 1px solid var(--color-line); border-radius: var(--radius-xl); overflow: hidden; background: var(--color-bg); }
.panel-head { margin-bottom: var(--space-4); }
.panel-head-actions { margin-top: var(--space-3); display: flex; justify-content: flex-end; }
.ext-jsonc-textarea { min-height: 360px; font-family: var(--font-mono); font-size: var(--text-sm); line-height: var(--leading-normal); tab-size: 2; }
.panel-kicker { font-size: var(--text-xs); letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-text-faint); margin-bottom: var(--space-1); }
.panel-title { margin: 0 0 var(--space-2); font-family: var(--font-ui); font-size: var(--text-2xl); font-weight: var(--weight-semibold); letter-spacing: -0.01em; color: var(--color-text); }
.panel-desc { margin: 0; font-family: var(--font-ui); font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--color-text-muted); max-width: 560px; }
.archive-toolbar { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); flex-wrap: wrap; }
.archive-search { flex: 1; min-width: 200px; height: 36px; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line); color: var(--color-text-faint); font-size: var(--text-sm); background: var(--color-surface-raised); transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.archive-search:focus-within { border-color: var(--color-accent); box-shadow: var(--p-focus-ring); color: var(--color-text-muted); }
.archive-search svg { width: 15px; height: 15px; flex: none; }
.archive-search input { width: 100%; border: none; outline: none; background: transparent; font: inherit; color: var(--color-text); }
.archive-list { display: flex; flex-direction: column; gap: var(--space-4); }
.archive-card .setting-card { margin-bottom: 0; }
.archive-workspace { display: flex; align-items: center; gap: var(--space-2); margin: 0 2px var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.archive-workspace svg { width: 16px; height: 16px; color: var(--color-text-faint); flex: none; }
.archive-workspace .path { font-family: var(--font-mono); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-workspace .count { margin-left: auto; color: var(--color-text-faint); font-weight: var(--weight-regular); font-size: var(--text-xs); flex: none; }
.archive-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-top: 1px solid var(--color-line); }
.archive-row:first-child { border-top: none; }
.archive-row:hover { background: var(--color-surface-sunken); }
.archive-meta { min-width: 0; }
.archive-name { font-size: var(--text-base); font-weight: var(--weight-medium); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-time { margin-top: 2px; font-size: var(--text-xs); color: var(--color-text-faint); font-family: var(--font-mono); }
.archive-draining { margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent-hover); font-size: var(--text-sm); }
.archive-empty { padding: var(--space-6) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-xl); color: var(--color-text-faint); font-size: var(--text-sm); text-align: center; background: var(--color-bg); }
@media (max-width: 640px) {
  .archive-toolbar { flex-direction: column; align-items: stretch; }
  .archive-search { min-width: 0; }
}
/* Enlarge the settings frame a bit (Dialog `xl` = 760px wide, fixed-height
   680px). Scoped to this dialog only. */
:deep(.ui-dialog) { width: min(980px, 96vw); }
:deep(.ui-dialog--fixed-height) { height: min(780px, calc(100vh - var(--space-8) * 2)); }

/* MCP tab + Skills tab (shared card / form / badge styles) */
.ext-count { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--color-text-faint); flex: none; margin-left: var(--space-2); vertical-align: middle; font-weight: var(--weight-regular); }
.ext-error { margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-danger-soft, rgba(220, 38, 38, 0.08)); color: var(--color-danger, #dc2626); font-size: var(--text-sm); }
.ext-list { display: flex; flex-direction: column; gap: var(--space-3); }
.ext-card { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-bg); overflow: hidden; }
.ext-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-line); }
.ext-card-name { display: flex; align-items: center; gap: var(--space-2); min-width: 0; flex-wrap: wrap; }
.ext-name { font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext-badge { flex: none; padding: 2px 8px; border-radius: 9999px; background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-medium); font-family: var(--font-mono); }
.ext-badge-muted { background: var(--color-surface-sunken); color: var(--color-text-muted); }
.ext-card-actions { display: flex; gap: var(--space-2); flex: none; }
.ext-card-body { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.ext-field { display: flex; align-items: baseline; gap: var(--space-3); min-width: 0; }
.ext-field-label { flex: none; width: 88px; font-family: var(--font-ui); font-size: var(--text-xs); color: var(--color-text-faint); text-transform: uppercase; letter-spacing: 0.04em; }
.ext-field-value { font-size: var(--text-sm); color: var(--color-text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext-field-value.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.ext-add-row { margin-top: var(--space-3); }

.ext-form { margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--color-accent); border-radius: var(--radius-lg); background: var(--color-surface-raised); display: flex; flex-direction: column; gap: var(--space-3); }
.ext-form-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-1); }
.ext-form-title { font-family: var(--font-ui); font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--color-text); }
.ext-form-row { display: flex; align-items: center; gap: var(--space-3); }
.ext-form-row-stack { flex-direction: column; align-items: stretch; gap: var(--space-2); }
.ext-form-hint { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--color-text-faint); }
.ext-form-error { margin-top: var(--space-1); }
.ext-input { flex: 1; min-width: 0; height: 36px; padding: 0 var(--space-3); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-sm); transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.ext-input:hover { border-color: var(--color-line-strong); }
.ext-input:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ext-input.mono, .ext-input-num { font-family: var(--font-mono); }
.ext-input-num { flex: none; width: 96px; }
.ext-textarea { flex: 1; min-width: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading-normal); resize: vertical; transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.ext-textarea:hover { border-color: var(--color-line-strong); }
.ext-textarea:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ext-kv-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.ext-kv-row { display: flex; align-items: center; gap: var(--space-2); }
.ext-kv-key { flex: 0 0 160px; }
.ext-kv-value { flex: 1; }
.ext-form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

.ext-skills-hint { margin: 0 0 var(--space-2); font-family: var(--font-ui); font-size: var(--text-sm); color: var(--color-text-muted); max-width: 560px; line-height: var(--leading-normal); }
.ext-skill-row { display: flex; align-items: baseline; gap: var(--space-3); padding: var(--space-1) 0; border-top: 1px solid var(--color-line); }
.ext-skill-row:first-child { border-top: none; }
.ext-skill-name { flex: none; max-width: 240px; font-size: var(--text-xs); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext-skill-desc { flex: 1 1 auto; min-width: 0; font-family: var(--font-ui); font-size: var(--text-sm); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec-head-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
.sec-head-actions { display: flex; gap: var(--space-2); flex: none; }
.ext-card-row { padding: var(--space-2) var(--space-3); }
.ext-card-name-grow { flex: 1 1 auto; min-width: 0; }
.ext-skill-dir-index { flex: none; color: var(--color-text-faint); font-size: var(--text-xs); }
.ext-skill-dir-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext-add-row-inline { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); }
.ext-add-input { flex: 1 1 auto; min-width: 0; }

@media (max-width: 640px) {
  .ext-card-head { flex-direction: column; align-items: stretch; }
  .ext-card-actions { justify-content: flex-end; }
  .ext-form-row { flex-direction: column; align-items: stretch; }
  .ext-input-num { width: 100%; }
  .ext-kv-key { flex: 1; }
  .ext-kv-row { flex-wrap: wrap; }
  .ext-field { flex-direction: column; gap: var(--space-1); }
  .ext-field-label { width: auto; }
}
</style>
