<!-- apps/kimi-web/src/components/Sidebar.vue -->
<!-- Unified sidebar: session groups with collapsible workspace headers.
     The old workspace rail and workspace tabs have been removed;
     workspace switching, folding and renaming all live in the group header. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup, WorkspaceView } from '../types';
import type { Accent, CodeFont, Theme } from '../composables/useKimiWebClient';
import { daemonEndpointLabel } from '../api/config';
import LanguageSwitcher from './LanguageSwitcher.vue';
import SessionRow from './SessionRow.vue';

const { t } = useI18n();

/** Address of the real daemon this client connects to (shown in the settings popover). */
const daemonEndpoint = daemonEndpointLabel();

const props = withDefaults(
  defineProps<{
    activeWorkspace: WorkspaceView | null;
    activeWorkspaceId: string | null;
    sessions: Session[];
    groups: WorkspaceGroup[];
    activeId: string;
    attentionBySession?: Record<string, number>;
    authReady?: boolean;
    accountModel?: string | null;
    /** Width (px) of the session column, driven by the App resize handle. */
    colWidth?: number;
    /** Active UI theme — forwarded to the settings popover. */
    theme?: Theme;
    /** Active code font — forwarded to the settings popover. */
    codeFont?: CodeFont;
    /** Accent / colour scheme — forwarded to the settings popover. */
    accent?: Accent;
  }>(),
  {
    activeWorkspace: null,
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    authReady: false,
    accountModel: null,
    colWidth: 220,
    theme: 'terminal',
    codeFont: 'sf-mono',
    accent: 'blue',
  },
);

const emit = defineEmits<{
  select: [sessionId: string];
  create: [];
  createInWorkspace: [workspaceId: string];
  selectWorkspace: [workspaceId: string];
  selectWorkspaces: [ids: string[]];
  addWorkspace: [];
  rename: [id: string, title: string];
  delete: [id: string];
  renameWorkspace: [id: string, name: string];
  login: [];
  logout: [];
  setTheme: [theme: Theme];
  setCodeFont: [font: CodeFont];
  setAccent: [accent: Accent];
  openOnboarding: [];
}>();

const totalSessionCount = computed(() => props.sessions.length);

const CODE_FONT_OPTIONS: { value: CodeFont; labelKey: string; family: string }[] = [
  { value: 'sf-mono', labelKey: 'theme.codeFontSfMono', family: 'var(--mono)' },
  { value: 'fira-code', labelKey: 'theme.codeFontFiraCode', family: '"Fira Code", monospace' },
  { value: 'jetbrains-mono', labelKey: 'theme.codeFontJetBrainsMono', family: '"JetBrains Mono", monospace' },
  { value: 'source-code-pro', labelKey: 'theme.codeFontSourceCodePro', family: '"Source Code Pro", monospace' },
  { value: 'ibm-plex-mono', labelKey: 'theme.codeFontIbmPlexMono', family: '"IBM Plex Mono", monospace' },
  { value: 'space-mono', labelKey: 'theme.codeFontSpaceMono', family: '"Space Mono", monospace' },
  { value: 'ubuntu-mono', labelKey: 'theme.codeFontUbuntuMono', family: '"Ubuntu Mono", monospace' },
];

// ---------------------------------------------------------------------------
// Collapse groups
// ---------------------------------------------------------------------------
const collapsedIds = ref<Set<string>>(new Set());

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedIds.value = next;
}

// ---------------------------------------------------------------------------
// Shift-multi-select workspaces
// ---------------------------------------------------------------------------
const selectedIds = ref<Set<string>>(new Set());

function handleGhClick(wsId: string, e: MouseEvent): void {
  if (e.shiftKey) {
    e.stopPropagation();
    const next = new Set(selectedIds.value);
    if (next.has(wsId)) next.delete(wsId);
    else next.add(wsId);
    selectedIds.value = next;
    emit('selectWorkspaces', Array.from(next));
    return;
  }
  // Normal click: clear multi-selection then toggle collapse
  selectedIds.value = new Set();
  emit('selectWorkspaces', []);
  toggleCollapse(wsId);
}

function onSelectSession(sessionId: string): void {
  selectedIds.value = new Set();
  emit('selectWorkspaces', []);
  emit('select', sessionId);
}

// ---------------------------------------------------------------------------
// Rename workspace (inline, like SessionRow)
// ---------------------------------------------------------------------------
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

function startRenameWorkspace(id: string, name: string): void {
  renamingId.value = id;
  renameValue.value = name;
  void nextTick().then(() => renameInputRef.value?.focus());
}

function confirmRenameWorkspace(): void {
  const id = renamingId.value;
  const name = renameValue.value.trim();
  if (id && name) {
    emit('renameWorkspace', id, name);
  }
  renamingId.value = null;
}

function cancelRenameWorkspace(): void {
  renamingId.value = null;
}

// ---------------------------------------------------------------------------
// Workspace right-click menu (copy path, rename)
// ---------------------------------------------------------------------------
const ghMenuOpen = ref(false);
const ghMenuTarget = ref<WorkspaceView | null>(null);
const ghMenuStyle = ref<Record<string, string>>({});
const ghMenuRef = ref<HTMLElement | null>(null);

function onGhMenuDocClick(e: MouseEvent): void {
  if (ghMenuRef.value && !ghMenuRef.value.contains(e.target as Node)) {
    closeGhMenu();
  }
}

function openGhMenu(ws: WorkspaceView, e: MouseEvent): void {
  if (e.shiftKey) {
    // shift+right-click = multi-select (same as shift+click)
    e.stopPropagation();
    const next = new Set(selectedIds.value);
    if (next.has(ws.id)) next.delete(ws.id);
    else next.add(ws.id);
    selectedIds.value = next;
    emit('selectWorkspaces', Array.from(next));
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  ghMenuTarget.value = ws;
  ghMenuStyle.value = {
    top: `${e.clientY}px`,
    left: `${e.clientX}px`,
  };
  ghMenuOpen.value = true;
  document.addEventListener('mousedown', onGhMenuDocClick, true);
}

function closeGhMenu(): void {
  ghMenuOpen.value = false;
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
  ghMenuTarget.value = null;
}

function copyPathFromMenu(): void {
  if (ghMenuTarget.value) {
    void navigator.clipboard.writeText(ghMenuTarget.value.root);
  }
  closeGhMenu();
}

function startRenameFromMenu(): void {
  if (ghMenuTarget.value) {
    startRenameWorkspace(ghMenuTarget.value.id, ghMenuTarget.value.name);
  }
  closeGhMenu();
}

// ---------------------------------------------------------------------------
// Account popover (top-right of the column header)
// ---------------------------------------------------------------------------
const acctMenuOpen = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

function positionMenu(): void {
  const trig = triggerRef.value;
  const menu = menuRef.value;
  if (!trig || !menu) return;
  const r = trig.getBoundingClientRect();
  const gap = 8;
  const margin = 8;
  const menuH = menu.offsetHeight;
  const menuW = menu.offsetWidth;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

async function openAccount(): Promise<void> {
  acctMenuOpen.value = true;
  await nextTick();
  positionMenu();
  window.addEventListener('resize', positionMenu);
}

function toggleAccount(): void {
  if (acctMenuOpen.value) closeAccount();
  else void openAccount();
}

function closeAccount(): void {
  acctMenuOpen.value = false;
  window.removeEventListener('resize', positionMenu);
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', positionMenu);
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
});

function onLogin(): void {
  acctMenuOpen.value = false;
  emit('login');
}

function onLogout(): void {
  acctMenuOpen.value = false;
  emit('logout');
}

function onOpenOnboarding(): void {
  acctMenuOpen.value = false;
  emit('openOnboarding');
}

// Logo easter-egg: clicking the Kimi mark plays one quick blink. It's a one-shot
// animation — force a reflow so rapid clicks restart it, then drop the class so
// the idle look/blink loop resumes.
const logoRef = ref<SVGSVGElement | null>(null);
let blinkTimer: ReturnType<typeof setTimeout> | undefined;
function blinkOnce(): void {
  const el = logoRef.value;
  if (!el) return;
  el.classList.remove('blink-now');
  void el.getBoundingClientRect();
  el.classList.add('blink-now');
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => el.classList.remove('blink-now'), 300);
}
</script>

<template>
  <aside class="side" @click="closeAccount">
    <!-- Session column -->
    <div class="col" :style="{ width: colWidth + 'px' }">
      <!-- Header: logo + settings (no hard border — flows into workspace list) -->
      <div class="ch">
        <svg ref="logoRef" class="ch-logo" viewBox="0 0 32 22" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="blinkOnce">
          <defs>
            <mask id="kimiEyes" maskUnits="userSpaceOnUse">
              <rect x="0" y="0" width="32" height="22" fill="#fff" />
              <g class="ch-eyes" fill="#000">
                <rect class="ch-eye" x="11.8" y="7" width="2.8" height="8" rx="1.4" />
                <rect class="ch-eye" x="17.4" y="7" width="2.8" height="8" rx="1.4" />
              </g>
            </mask>
          </defs>
          <rect x="1" y="1" width="30" height="20" rx="6" fill="var(--logo)" mask="url(#kimiEyes)" />
        </svg>
        <button
          ref="triggerRef"
          type="button"
          class="settings-btn"
          :title="authReady ? t('sidebar.signedIn') : t('sidebar.notSignedIn')"
          :aria-label="authReady ? t('sidebar.signedIn') : t('sidebar.notSignedIn')"
          @click.stop="toggleAccount"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
          </svg>
        </button>
      </div>

      <!-- New workspace button -->
      <div class="btn-wrap">
        <button class="btn-new-ws" @click.stop="emit('addWorkspace')">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10"/>
          </svg>
          <span>{{ t('sidebar.newWorkspace') }}</span>
        </button>
      </div>

      <!-- Session list — grouped by workspace -->
      <div class="sessions">
        <!-- Empty state -->
        <div v-if="totalSessionCount === 0" class="empty">
          {{ t('sidebar.emptyState') }}
        </div>

        <template v-else>
          <div v-for="g in groups" :key="g.workspace.id" class="group">
            <div
              class="gh"
              :class="{ on: g.workspace.id === activeWorkspaceId, sel: selectedIds.has(g.workspace.id) }"
              @click.stop="handleGhClick(g.workspace.id, $event)"
              @contextmenu="openGhMenu(g.workspace, $event)"
            >
              <div class="gh-top">
                <!-- Folder icon -->
                <svg
                  class="gh-folder"
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  aria-hidden="true"
                >
                  <template v-if="isCollapsed(g.workspace.id)">
                    <rect x="1" y="3.5" width="12" height="8.5" rx="1"/>
                    <path d="M1 5V3.5A1 1 0 0 1 2 2.5h3.5l1.3 2"/>
                  </template>
                  <template v-else>
                    <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
                    <path d="M1 5.5h12"/>
                  </template>
                </svg>

                <!-- Workspace name -->
                <span
                  v-if="renamingId !== g.workspace.id"
                  class="gh-name"
                >{{ g.workspace.name }}</span>
                <input
                  v-else
                  ref="renameInputRef"
                  v-model="renameValue"
                  class="gh-rename"
                  type="text"
                  @keydown.enter="confirmRenameWorkspace"
                  @keydown.esc="cancelRenameWorkspace"
                  @blur="cancelRenameWorkspace"
                  @click.stop
                />

                <button
                  class="gh-add"
                  :title="t('workspace.newInGroup')"
                  @click.stop="emit('createInWorkspace', g.workspace.id)"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M8 3v10M3 8h10"/>
                  </svg>
                </button>
              </div>
              <div class="gh-path" :title="g.workspace.root">{{ g.workspace.branch || g.workspace.shortPath }}</div>
            </div>
            <div v-show="!isCollapsed(g.workspace.id)" class="group-sessions">
              <SessionRow
                v-for="s in g.sessions"
                :key="s.id"
                :session="s"
                :active="s.id === activeId"
                :attention="attentionBySession[s.id] ?? 0"
                @select="onSelectSession($event)"
                @rename="(id, title) => emit('rename', id, title)"
                @delete="emit('delete', $event)"
              />
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Account popover (position:fixed, anchored to the settings button) -->
    <div
      v-if="acctMenuOpen"
      ref="menuRef"
      class="acct-menu"
      :style="menuStyle"
      @click.stop
    >
      <template v-if="authReady">
        <div class="am-head">
          <div class="am-prov">managed:kimi-code</div>
          <div v-if="accountModel" class="am-model" :title="accountModel">{{ accountModel }}</div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('theme.label') }}</span>
          <div class="theme-seg" role="group" :aria-label="t('theme.label')">
            <button
              type="button"
              class="theme-opt"
              :class="{ on: theme === 'modern' }"
              :aria-pressed="theme === 'modern'"
              @click="emit('setTheme', 'modern')"
            >{{ t('theme.modern') }}</button>
            <button
              type="button"
              class="theme-opt"
              :class="{ on: theme === 'terminal' }"
              :aria-pressed="theme === 'terminal'"
              @click="emit('setTheme', 'terminal')"
            >{{ t('theme.terminal') }}</button>
          </div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('theme.accentLabel') }}</span>
          <div class="theme-seg" role="group" :aria-label="t('theme.accentLabel')">
            <button
              type="button"
              class="theme-opt"
              :class="{ on: accent === 'blue' }"
              :aria-pressed="accent === 'blue'"
              @click="emit('setAccent', 'blue')"
            >{{ t('theme.accentBlue') }}</button>
            <button
              type="button"
              class="theme-opt"
              :class="{ on: accent === 'mono' }"
              :aria-pressed="accent === 'mono'"
              @click="emit('setAccent', 'mono')"
            >{{ t('theme.accentMono') }}</button>
          </div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('theme.codeFontLabel') }}</span>
          <div class="font-grid" role="group" :aria-label="t('theme.codeFontLabel')">
            <button
              v-for="f in CODE_FONT_OPTIONS"
              :key="f.value"
              type="button"
              class="font-opt"
              :class="{ on: codeFont === f.value }"
              :aria-pressed="codeFont === f.value"
              :style="{ fontFamily: f.family }"
              @click="emit('setCodeFont', f.value)"
            >{{ t(f.labelKey) }}</button>
          </div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('sidebar.language') }}</span>
          <LanguageSwitcher />
        </div>
        <button type="button" class="am-item" @click="emit('addWorkspace'); closeAccount()">
          {{ t('workspace.addWorkspace') }}
        </button>
        <button type="button" class="am-item danger" @click="onLogout">{{ t('sidebar.signOut') }}</button>
      </template>
      <template v-else>
        <div class="am-head">
          <div class="am-prov">{{ t('sidebar.notSignedIn') }}</div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('theme.label') }}</span>
          <div class="theme-seg" role="group" :aria-label="t('theme.label')">
            <button
              type="button"
              class="theme-opt"
              :class="{ on: theme === 'modern' }"
              :aria-pressed="theme === 'modern'"
              @click="emit('setTheme', 'modern')"
            >{{ t('theme.modern') }}</button>
            <button
              type="button"
              class="theme-opt"
              :class="{ on: theme === 'terminal' }"
              :aria-pressed="theme === 'terminal'"
              @click="emit('setTheme', 'terminal')"
            >{{ t('theme.terminal') }}</button>
          </div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('theme.accentLabel') }}</span>
          <div class="theme-seg" role="group" :aria-label="t('theme.accentLabel')">
            <button
              type="button"
              class="theme-opt"
              :class="{ on: accent === 'blue' }"
              :aria-pressed="accent === 'blue'"
              @click="emit('setAccent', 'blue')"
            >{{ t('theme.accentBlue') }}</button>
            <button
              type="button"
              class="theme-opt"
              :class="{ on: accent === 'mono' }"
              :aria-pressed="accent === 'mono'"
              @click="emit('setAccent', 'mono')"
            >{{ t('theme.accentMono') }}</button>
          </div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('theme.codeFontLabel') }}</span>
          <div class="font-grid" role="group" :aria-label="t('theme.codeFontLabel')">
            <button
              v-for="f in CODE_FONT_OPTIONS"
              :key="f.value"
              type="button"
              class="font-opt"
              :class="{ on: codeFont === f.value }"
              :aria-pressed="codeFont === f.value"
              :style="{ fontFamily: f.family }"
              @click="emit('setCodeFont', f.value)"
            >{{ t(f.labelKey) }}</button>
          </div>
        </div>
        <div class="am-lang">
          <span class="am-lang-label">{{ t('sidebar.language') }}</span>
          <LanguageSwitcher />
        </div>
        <button type="button" class="am-item" @click="emit('addWorkspace'); closeAccount()">
          {{ t('workspace.addWorkspace') }}
        </button>
        <button type="button" class="am-item signin" @click="onLogin">{{ t('sidebar.signIn') }}</button>
      </template>

      <button type="button" class="am-item" @click="onOpenOnboarding">{{ t('onboarding.reopen') }}</button>

      <div class="am-daemon">
        <span class="am-daemon-label">{{ t('sidebar.daemon') }}</span>
        <span class="am-daemon-url">{{ daemonEndpoint }}</span>
      </div>
    </div>

    <!-- Workspace right-click menu (position:fixed) -->
    <div
      v-if="ghMenuOpen"
      ref="ghMenuRef"
      class="gh-menu"
      :style="ghMenuStyle"
      @click.stop
    >
      <button type="button" class="ghm-item" @click="copyPathFromMenu">
        {{ t('sidebar.copyPath') }}
      </button>
      <button type="button" class="ghm-item" @click="startRenameFromMenu">
        {{ t('sidebar.rename') }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.side {
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: row;
  min-width: 0;
  height: 100%;
  /* Alignment contract, inherited by SessionRow and the theme overrides in
     style.css: text in the workspace header, the path line and session rows
     all starts at --sb-pad-x + --sb-gutter + --sb-gap from the sidebar edge. */
  --sb-pad-x: 12px;  /* row horizontal padding */
  --sb-gutter: 16px; /* leading icon slot (14px folder icon + 2px margin) */
  --sb-gap: 6px;     /* gap between the icon slot and the text */
}

/* Session column. Width is set inline from the App resize handle. */
.col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
}

/* Header: logo + settings (no border — flows into the workspace list). */
.ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px 4px;
  width: 100%;
  box-sizing: border-box;
}
.ch-logo {
  height: 22px;
  width: auto;
  display: block;
  cursor: pointer;
  user-select: none;
}
.ch-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-btn {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.settings-btn:hover { background: var(--soft); color: var(--ink); }

/* Action buttons */
 .btn-wrap {
  padding: 10px 12px;
}
.btn-new-ws {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 9px 12px;
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 400;
  color: var(--dim);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.btn-new-ws:hover {
  background: var(--panel);
  border-color: var(--bd);
  color: var(--ink);
}

/* Sessions */
.sessions {
  flex: 1;
  overflow-y: auto;
  padding: 0 0 8px;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.sessions::-webkit-scrollbar { width: 4px; }
.sessions::-webkit-scrollbar-track { background: transparent; }
.sessions::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 2px;
}
.sessions::-webkit-scrollbar-thumb:hover { background: var(--bd); }

.empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--faint);
  font-size: 11px;
  line-height: 1.6;
}

/* Workspace group */
.group { padding-bottom: 6px; }
.gh {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--sb-pad-x) 4px;
  font-size: 10.5px;
  user-select: none;
}
.gh-top {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
}
.gh.sel {
  background: var(--soft);
  border-radius: 4px;
}

.gh-folder {
  flex: none;
  color: var(--muted);
  /* 14px icon + 2px margin fills the --sb-gutter icon slot */
  margin-right: calc(var(--sb-gutter) - 14px);
}

.gh-name {
  font-size: 14px;
  font-weight: 400;
  color: var(--ink);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.gh-path {
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: calc(var(--sb-gutter) + var(--sb-gap));
  font-size: 12px;
}
.gh-add {
  background: transparent;
  border: none;
  color: #bbb;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  flex: none;
}
.gh-add:hover { color: #666; }

/* Inline workspace rename input */
.gh-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 400;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 3px;
  padding: 2px 5px;
  outline: none;
}



/* ---------------------------------------------------------------------------
   Workspace right-click menu (position:fixed)
   --------------------------------------------------------------------------- */
.gh-menu {
  position: fixed;
  top: 0;
  left: 0;
  min-width: 140px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 200;
}
.ghm-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text);
  background: transparent;
  border: none;
  cursor: pointer;
}
.ghm-item:hover {
  background: var(--soft);
}

/* ---------------------------------------------------------------------------
   Account popover (position:fixed, anchored to the settings button)
   --------------------------------------------------------------------------- */
.acct-menu {
  position: fixed;
  top: 0;
  left: 0;
  width: 220px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 200;
}
.am-head {
  padding: 6px 8px 7px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
}
.am-prov { color: var(--ink); font-size: 11.5px; }
.am-model {
  color: var(--muted);
  font-size: 10.5px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--ink);
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 5px;
}
.am-item:hover { background: var(--hover, rgba(0, 0, 0, 0.04)); }
.am-item.danger { color: #c0392b; }
.am-item.danger:hover { background: rgba(192, 57, 43, 0.08); }
.am-item.signin { color: var(--blue2); }
.am-item.signin:hover { background: var(--soft); }

.am-lang {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
}
.am-lang-label { color: var(--muted); font-size: 11px; }

.am-daemon {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 8px 5px;
  margin-top: 2px;
  border-top: 1px solid var(--line);
}
.am-daemon-label { color: var(--muted); font-size: 10.5px; flex: none; }
.am-daemon-url {
  color: var(--ink);
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  min-width: 0;
  word-break: break-all;
}

/* Theme segmented toggle */
.theme-seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg);
}
.theme-opt {
  border: none;
  background: none;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  cursor: pointer;
  padding: 3px 9px;
  line-height: 1.4;
  transition: background 0.15s, color 0.15s;
}
.theme-opt + .theme-opt { border-left: 1px solid var(--line); }
.theme-opt:hover { color: var(--ink); }
.theme-opt.on {
  background: var(--soft);
  color: var(--blue2);
  font-weight: 600;
}

/* Code font grid */
.font-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.font-opt {
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--bg);
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  padding: 3px 6px;
  line-height: 1.4;
  text-align: center;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.font-opt:hover {
  color: var(--ink);
  border-color: var(--line2);
}
.font-opt.on {
  background: var(--soft);
  border-color: var(--bd);
  color: var(--blue2);
  font-weight: 600;
}
</style>
