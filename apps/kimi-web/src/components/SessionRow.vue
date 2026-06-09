<!-- apps/kimi-web/src/components/SessionRow.vue -->
<!-- A single session row: status dot + title + time + attention pill + kebab. -->
<!-- Inline rename (dblclick) and delete-confirm live here. -->
<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    session: Session;
    active: boolean;
    attention?: number;
  }>(),
  { attention: 0 },
);

const emit = defineEmits<{
  select: [id: string];
  rename: [id: string, title: string];
  delete: [id: string];
}>();

// Kebab menu
const menuOpen = ref(false);
function toggleMenu(e: Event): void {
  e.stopPropagation();
  menuOpen.value = !menuOpen.value;
}
function closeMenu(): void {
  menuOpen.value = false;
}

// Inline rename
const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
async function startRename(): Promise<void> {
  closeMenu();
  renaming.value = true;
  renameValue.value = props.session.title;
  await nextTick();
  try {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  } catch {
    // jsdom may not implement focus/select
  }
}
function commitRename(): void {
  const newTitle = renameValue.value.trim();
  if (newTitle) emit('rename', props.session.id, newTitle);
  renaming.value = false;
}
function cancelRename(): void {
  renaming.value = false;
}

// Copy session ID
const copiedId = ref(false);
function copySessionId(): void {
  navigator.clipboard.writeText(props.session.id).then(() => {
    copiedId.value = true;
    setTimeout(() => { copiedId.value = false; }, 1200);
  }).catch(() => {/* ignore */});
}

// Delete confirm
const confirming = ref(false);
function startDelete(): void {
  closeMenu();
  confirming.value = true;
}
function confirmDelete(): void {
  emit('delete', props.session.id);
  confirming.value = false;
}
function cancelDelete(): void {
  confirming.value = false;
}

// Expose closeMenu so the parent can close on outside-click.
defineExpose({ closeMenu, cancelDelete });
</script>

<template>
  <div class="se" :class="{ on: active }" @click="emit('select', session.id)">
    <!-- Delete confirm overlay -->
    <div v-if="confirming" class="del-confirm" @click.stop>
      <span class="del-label">{{ t('sidebar.deleteConfirm') }}</span>
      <button class="btn-confirm" @click.stop="confirmDelete">{{ t('sidebar.confirm') }}</button>
      <button class="btn-cancel" @click.stop="cancelDelete">{{ t('sidebar.cancel') }}</button>
    </div>

    <template v-else>
      <div class="row">
        <span class="pre" :class="{ run: session.status === 'running' }">
          {{ session.status === 'running' ? '●' : '○' }}
        </span>

        <!-- Inline rename input -->
        <input
          v-if="renaming"
          ref="renameInputRef"
          v-model="renameValue"
          class="rename-input"
          @click.stop
          @keydown.enter.stop="commitRename"
          @keydown.esc.stop="cancelRename"
          @blur="commitRename"
        />
        <span v-else class="t" @dblclick.stop="startRename">{{ session.title }}</span>

        <!-- Attention pill — shown even when the row isn't active -->
        <span
          v-if="!renaming && attention > 0"
          class="attn"
          :title="t('workspace.attentionTitle', attention)"
        >
          <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M8 4v5" /><circle cx="8" cy="12" r="0.6" fill="currentColor" stroke="none" />
          </svg>
          {{ attention }}
        </span>

        <!-- Kebab button (visible on hover) -->
        <button
          v-if="!renaming"
          class="kebab"
          :class="{ open: menuOpen }"
          :title="t('sidebar.options')"
          @click.stop="toggleMenu($event)"
        >⋯</button>
      </div>

      <!-- Kebab dropdown -->
      <div v-if="menuOpen" class="menu" @click.stop>
        <button class="menu-item copy-id" @click.stop="copySessionId">
          {{ copiedId ? '已复制 ✓' : '复制 Session ID ⧉' }}
        </button>
        <div class="menu-divider" />
        <button class="menu-item" @click.stop="startRename">{{ t('sidebar.rename') }}</button>
        <button class="menu-item del" @click.stop="startDelete">{{ t('sidebar.delete') }}</button>
      </div>

      <div class="ts">{{ session.time }}</div>
    </template>
  </div>
</template>

<style scoped>
.se {
  display: block;
  padding: 7px 12px;
  cursor: pointer;
  position: relative;
}
.se:hover { background: var(--panel2); }
.se.on { background: rgba(21, 101, 192, 0.07); }

.row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.pre { color: var(--faint); flex: none; }
.pre.run { color: var(--ok); }
.se.on .pre { color: var(--blue); }

.t {
  color: var(--ink);
  font-size: 14px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.se.on .t { font-weight: 500; }

/* Attention pill — small Kimi-blue badge with count */
.attn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  background: var(--soft);
  color: var(--blue2);
  border: 1px solid var(--bd);
  border-radius: 9px;
  font-size: 10px;
  line-height: 1;
  padding: 1px 5px 1px 4px;
  font-family: var(--mono);
}
.attn svg { flex: none; }

/* Kebab button — hidden until hover */
.kebab {
  display: none;
  flex: none;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 3px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  font-family: var(--mono);
  border-radius: 3px;
  margin-left: auto;
}
.se:hover .kebab,
.kebab.open {
  display: inline-flex;
  align-items: center;
}
.attn + .kebab { margin-left: 0; }
.kebab:hover,
.kebab.open { color: var(--ink); background: var(--line2); }

.menu {
  position: absolute;
  right: 10px;
  top: 30px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
  min-width: 88px;
}
.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
  padding: 6px 12px;
}
.menu-item:hover { background: var(--panel2); }
.menu-item.del { color: var(--err); }

.menu-divider {
  height: 1px;
  background: var(--line);
  margin: 2px 0;
}

.rename-input {
  flex: 1;
  font-family: var(--mono);
  font-size: 14px;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 2px;
  padding: 1px 4px;
  outline: none;
  min-width: 0;
}

.del-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 11px;
}
.del-label { color: var(--err); flex: 1; }
.btn-confirm {
  background: var(--err);
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10.5px;
}
.btn-cancel {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
}
.btn-confirm:hover { opacity: 0.85; }
.btn-cancel:hover { background: var(--panel2); }

.ts { color: var(--muted); font-size: 10.5px; padding-left: 15px; margin-top: 1px; }
</style>
