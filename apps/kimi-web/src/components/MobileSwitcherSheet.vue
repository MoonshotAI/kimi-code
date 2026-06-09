<!-- apps/kimi-web/src/components/MobileSwitcherSheet.vue -->
<!-- Mobile switcher bottom sheet: a horizontal row of workspace chips (46px -->
<!-- rounded squares + label, active = dark filled), a `SESSIONS · <WS>` label, -->
<!-- a `+ New session` row, then the active workspace's session rows (status dot -->
<!-- + title + sub-line + attention badge + ⋯ menu). Tapping a session selects it -->
<!-- AND closes the sheet. Matches docs/mobile-prototype.html. Terminal Pro style. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceView } from '../types';
import BottomSheet from './BottomSheet.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    workspaces: WorkspaceView[];
    activeWorkspace: WorkspaceView | null;
    activeWorkspaceId: string | null;
    /** Sessions for the active workspace (the same list the sidebar shows). */
    sessions: Session[];
    activeId: string;
    attentionBySession?: Record<string, number>;
    attentionByWorkspace?: Record<string, number>;
  }>(),
  {
    activeWorkspace: null,
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    attentionByWorkspace: () => ({}),
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  select: [sessionId: string];
  selectWorkspace: [workspaceId: string];
  create: [];
  addWorkspace: [];
  rename: [id: string, title: string];
  delete: [id: string];
}>();

function close(): void {
  emit('update:modelValue', false);
}

/** First letter of a workspace name for the chip glyph. */
function initial(w: WorkspaceView): string {
  const ch = (w.name || w.root).trim().charAt(0);
  return ch ? ch.toUpperCase() : '·';
}

function attentionFor(id: string): number {
  return props.attentionByWorkspace[id] ?? 0;
}

const sessionsHeader = computed(() => {
  const name = props.activeWorkspace?.name;
  const base = t('sidebar.sessionsHeader');
  return name ? `${base} · ${name}` : base;
});

function onSelectSession(id: string): void {
  emit('select', id);
  close();
}

function onSelectWorkspace(id: string): void {
  emit('selectWorkspace', id);
  // Stay open: switching workspace should reveal that workspace's sessions.
}

function onCreate(): void {
  emit('create');
  close();
}

function onAddWorkspace(): void {
  emit('addWorkspace');
  close();
}

// ---------------------------------------------------------------------------
// Per-row kebab menu (rename / delete) — opened from the ⋯ button.
// ---------------------------------------------------------------------------
const menuFor = ref<string | null>(null);
function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? null : id;
}
function onRename(s: Session): void {
  menuFor.value = null;
  const next = typeof window !== 'undefined' ? window.prompt(t('sidebar.rename'), s.title) : null;
  const title = next?.trim();
  if (title) emit('rename', s.id, title);
}
function onDelete(id: string): void {
  menuFor.value = null;
  emit('delete', id);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- Workspace chips row: 46px square + label, active = dark filled -->
    <div class="wschips" role="listbox" :aria-label="t('workspace.railLabel')">
      <button
        v-for="w in workspaces"
        :key="w.id"
        type="button"
        class="wschip"
        :class="{ on: w.id === activeWorkspaceId }"
        :title="w.name"
        @click="onSelectWorkspace(w.id)"
      >
        <span class="sq">
          {{ initial(w) }}
          <span v-if="attentionFor(w.id) > 0" class="ws-badge">{{ attentionFor(w.id) }}</span>
        </span>
        <span class="lb">{{ w.name }}</span>
      </button>
      <button
        type="button"
        class="wschip add"
        :aria-label="t('workspace.addWorkspace')"
        @click="onAddWorkspace"
      >
        <span class="sq add-sq">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </span>
        <span class="lb">{{ t('workspace.addWorkspace') }}</span>
      </button>
    </div>

    <!-- SESSIONS · <WS> label -->
    <div class="seclbl">{{ sessionsHeader }}</div>

    <!-- + New session -->
    <button type="button" class="newrow" @click="onCreate">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M8 3v10M3 8h10" />
      </svg>
      {{ t('mobile.newSession') }}
    </button>

    <!-- Session list (prototype .srow layout) -->
    <div class="mlist">
      <div v-if="sessions.length === 0" class="mempty">{{ t('sidebar.emptyState') }}</div>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="srow"
        :class="{ cur: s.id === activeId }"
        @click="onSelectSession(s.id)"
      >
        <span class="d" :class="{ run: s.status === 'running' }" />
        <div class="m">
          <div class="t">{{ s.title }}</div>
          <div class="s">{{ s.time }}</div>
        </div>
        <span v-if="(attentionBySession[s.id] ?? 0) > 0" class="att">{{ attentionBySession[s.id] }}</span>
        <button
          type="button"
          class="kb"
          :title="t('sidebar.options')"
          @click.stop="toggleMenu(s.id)"
        >⋯</button>

        <!-- Kebab menu -->
        <div v-if="menuFor === s.id" class="kmenu" @click.stop>
          <button class="kitem" @click.stop="onRename(s)">{{ t('sidebar.rename') }}</button>
          <button class="kitem del" @click.stop="onDelete(s.id)">{{ t('sidebar.delete') }}</button>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
/* ---- Workspace chips row ---- */
.wschips {
  display: flex;
  gap: 9px;
  padding: 4px 16px 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.wschip {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}
.wschip .sq {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--bg);
  border: 1.5px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 17px;
  color: var(--muted);
}
.wschip.on .sq {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}
.wschip .lb {
  font-size: 10px;
  color: var(--muted);
  max-width: 54px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wschip.on .lb { color: var(--ink); font-weight: 600; }
.wschip.add .sq.add-sq {
  border-style: dashed;
  border-color: var(--blue);
  color: var(--blue);
}
.ws-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--warn);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  line-height: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ---- SESSIONS section label ---- */
.seclbl {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 8px 16px 6px;
  border-top: 1px solid var(--line2);
}

/* ---- + New session row ---- */
.newrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px 16px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--line2);
  color: var(--blue);
  font-family: var(--mono);
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
}
.newrow:active { background: var(--panel); }

/* ---- Session rows (prototype .srow) ---- */
.mlist { padding-bottom: 4px; }
.mempty {
  padding: 24px 16px;
  text-align: center;
  color: var(--faint);
  font-size: 12px;
}
.srow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line2);
  cursor: pointer;
  position: relative;
}
.srow:active { background: var(--panel); }
.srow.cur { background: var(--bluebg); }
.srow .d {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--dim);
}
.srow .d.run { background: var(--ok); }
.srow .m { flex: 1; min-width: 0; }
.srow .m .t {
  font-size: 13.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow.cur .m .t { font-weight: 600; color: var(--blue2); }
.srow .m .s {
  font-size: 11px;
  color: var(--faint);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow .att {
  flex: none;
  font-family: var(--mono);
  font-size: 10px;
  color: #fff;
  background: var(--warn);
  border-radius: 10px;
  padding: 1px 7px;
}
.srow .kb {
  flex: none;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  font-size: 18px;
  line-height: 1;
  padding: 6px 4px;
  font-family: var(--mono);
}
.srow .kb:active { color: var(--ink); }

/* Kebab menu */
.kmenu {
  position: absolute;
  right: 12px;
  top: 44px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  z-index: 10;
  box-shadow: 0 4px 16px rgba(18, 22, 30, 0.16);
  overflow: hidden;
  min-width: 96px;
}
.kitem {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink);
  padding: 10px 14px;
}
.kitem:active { background: var(--panel2); }
.kitem.del { color: var(--err); }
</style>
