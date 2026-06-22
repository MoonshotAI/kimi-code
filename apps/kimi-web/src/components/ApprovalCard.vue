<!-- apps/kimi-web/src/components/ApprovalCard.vue -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApprovalBlock } from '../types';
import type { ApprovalDecision } from '../api/types';

const props = defineProps<{
  block: ApprovalBlock;
  agentName?: string;
}>();

const emit = defineEmits<{
  decide: [response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string }];
}>();

const { t } = useI18n();

// Temporarily collapse to a thin bar so the approval stops covering the chat
// while the user reads. The decision buttons + body return on expand.
const minimized = ref(false);

// ---------------------------------------------------------------------------
// Title by kind
// ---------------------------------------------------------------------------

const titleKinds = ['shell', 'diff', 'file', 'fileop', 'url', 'search', 'invocation', 'todo', 'generic'];

function title(): string {
  const kind = titleKinds.includes(props.block.kind) ? props.block.kind : 'generic';
  return t(`approval.title.${kind}`);
}

// ---------------------------------------------------------------------------
// Inline feedback
// ---------------------------------------------------------------------------

const feedbackOpen = ref(false);
const feedbackText = ref('');
const feedbackRef = ref<HTMLTextAreaElement | null>(null);

function openFeedback(): void {
  feedbackOpen.value = true;
  feedbackText.value = '';
  // Focus textarea next tick
  setTimeout(() => feedbackRef.value?.focus(), 0);
}

function submitFeedback(): void {
  const fb = feedbackText.value.trim();
  emit('decide', { decision: 'rejected', feedback: fb || undefined });
  feedbackOpen.value = false;
  feedbackText.value = '';
}

function cancelFeedback(): void {
  feedbackOpen.value = false;
  feedbackText.value = '';
}

function onFeedbackKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitFeedback();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelFeedback();
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function approve(): void { emit('decide', { decision: 'approved' }); }
function approveSession(): void { emit('decide', { decision: 'approved', scope: 'session' }); }
function reject(): void { emit('decide', { decision: 'rejected' }); }

// ---------------------------------------------------------------------------
// Number key shortcuts: 1=approve, 2=session, 3=reject, 4=feedback
// Guard: do not fire when a textarea/input is focused
// ---------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  // Hidden actions shouldn't fire from number keys while minimized.
  if (minimized.value) return;
  if (e.key === '1') { e.preventDefault(); approve(); }
  else if (e.key === '2') { e.preventDefault(); approveSession(); }
  else if (e.key === '3') { e.preventDefault(); reject(); }
  else if (e.key === '4') { e.preventDefault(); openFeedback(); }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div class="appr" :class="{ minimized }">
    <!-- Header -->
    <div class="ah">
      <span class="akind">{{ title() }}</span>
      <span class="apath">
        <template v-if="block.kind === 'diff' || block.kind === 'file' || block.kind === 'fileop'">{{ block.path }}</template>
        <template v-else-if="block.kind === 'shell'">{{ block.command }}</template>
        <template v-else-if="block.kind === 'url'">{{ block.url }}</template>
        <template v-else-if="block.kind === 'search'">{{ block.query }}</template>
        <template v-else-if="block.kind === 'invocation'">{{ block.name }}</template>
        <template v-else-if="block.kind === 'generic'">{{ block.summary }}</template>
      </span>
      <span v-if="agentName && !minimized" class="abadge">{{ t('approval.subagentBadge', { name: agentName }) }}</span>
      <span v-if="!minimized" class="aw">{{ t('approval.required') }}</span>
      <button
        class="amin"
        :title="minimized ? t('question.expand') : t('question.minimize')"
        :aria-label="minimized ? t('question.expand') : t('question.minimize')"
        @click="minimized = !minimized"
      >
        <svg v-if="minimized" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>
        <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10"/></svg>
      </button>
    </div>

    <!-- Body + actions collapse when minimized -->
    <template v-if="!minimized">
    <!-- Body by kind -->

    <!-- diff -->
    <div v-if="block.kind === 'diff'" class="diff">
      <div v-for="(line, i) in block.diff" :key="i" class="dl" :class="line.kind === 'add' ? 'add' : line.kind === 'rem' ? 'del' : ''">
        <span class="dg">{{ line.gutter }}</span><span class="dc">{{ line.text }}</span>
      </div>
    </div>

    <!-- shell -->
    <div v-else-if="block.kind === 'shell'" class="body-shell">
      <div class="shell-cmd"><span class="shell-dollar">$</span> {{ block.command }}</div>
      <div v-if="block.cwd" class="shell-cwd">cwd: {{ block.cwd }}</div>
      <div v-if="block.danger" class="shell-danger">{{ t('approval.danger', { detail: block.danger }) }}</div>
    </div>

    <!-- file -->
    <div v-else-if="block.kind === 'file'" class="body-file">
      <div class="file-bar">
        <span class="file-lang">{{ block.language ?? '' }}</span>
      </div>
      <div class="file-content">
        <div v-for="(line, i) in block.content.split('\n')" :key="i" class="file-line">
          <span class="file-ln">{{ i + 1 }}</span><span class="file-text">{{ line }}</span>
        </div>
      </div>
    </div>

    <!-- fileop -->
    <div v-else-if="block.kind === 'fileop'" class="body-chip">
      <span class="chip-label">{{ block.op }}</span>
      <span class="chip-value">{{ block.path }}</span>
      <span v-if="block.detail" class="chip-detail">{{ block.detail }}</span>
    </div>

    <!-- url -->
    <div v-else-if="block.kind === 'url'" class="body-chip">
      <span v-if="block.method" class="chip-label">{{ block.method }}</span>
      <span class="chip-value">{{ block.url }}</span>
    </div>

    <!-- search -->
    <div v-else-if="block.kind === 'search'" class="body-chip">
      <span class="chip-label">{{ t('approval.searchQueryLabel') }}</span>
      <span class="chip-value">{{ block.query }}</span>
      <span v-if="block.scope" class="chip-detail">{{ t('approval.searchScope', { scope: block.scope }) }}</span>
    </div>

    <!-- invocation -->
    <div v-else-if="block.kind === 'invocation'" class="body-chip">
      <span class="chip-label">{{ block.kind2 }}</span>
      <span class="chip-value">{{ block.name }}</span>
      <span v-if="block.description" class="chip-detail">{{ block.description }}</span>
    </div>

    <!-- todo -->
    <div v-else-if="block.kind === 'todo'" class="body-todo">
      <div v-for="(item, i) in block.items" :key="i" class="todo-item">
        <span class="todo-glyph">{{ item.status === 'done' || item.status === 'completed' ? '✓' : '○' }}</span>
        <span class="todo-title" :class="{ 'todo-done': item.status === 'done' || item.status === 'completed' }">{{ item.title }}</span>
      </div>
    </div>

    <!-- generic -->
    <div v-else class="body-generic">
      <span class="gen-text">{{ block.summary }}</span>
    </div>

    <!-- Inline feedback textarea -->
    <div v-if="feedbackOpen" class="feedback-wrap">
      <textarea
        ref="feedbackRef"
        v-model="feedbackText"
        class="feedback-ta"
        :placeholder="t('approval.feedbackPlaceholder')"
        rows="2"
        @keydown="onFeedbackKeydown"
      />
      <div class="feedback-hint">{{ t('approval.feedbackHint') }}</div>
    </div>

    <!-- Actions row -->
    <div class="abtn">
      <div class="kbtn pri" @click="approve">{{ t('approval.approve') }}<span class="k">[1]</span></div>
      <div class="kbtn" @click="approveSession">{{ t('approval.approveSession') }}<span class="k">[2]</span></div>
      <div class="kbtn" @click="reject">{{ t('approval.reject') }}<span class="k">[3]</span></div>
      <div class="kbtn" @click="openFeedback">{{ t('approval.feedback') }}<span class="k">[4]</span></div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.appr {
  border: 1px solid var(--bd);
  margin: 10px 0;
  background: var(--bg);
  border-radius: 3px;
}

/* Header */
.ah {
  padding: 7px 10px;
  background: var(--soft);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--ui-font-size);
  border-bottom: 1px solid var(--bd);
  border-radius: 3px 3px 0 0;
  flex-wrap: wrap;
}
.akind { color: var(--blue2); font-weight: 700; white-space: nowrap; }
.apath { color: var(--text); font-family: var(--mono); font-size: calc(var(--ui-font-size) - 2.5px); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.abadge {
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
  border: 1px solid var(--line);
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
.aw {
  margin-left: auto;
  color: var(--blue2);
  border: 1px solid var(--bd);
  padding: 1px 7px;
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  font-weight: 600;
  border-radius: 3px;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

/* Minimize toggle — when the "required" badge is hidden (minimized) it falls
   to the right via its own margin. */
.amin {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--bd);
  border-radius: 3px;
  background: var(--bg);
  color: var(--dim);
  cursor: pointer;
}
.appr.minimized .amin { margin-left: auto; }
.amin:hover { background: var(--panel2); color: var(--blue); }
.appr.minimized .ah { border-bottom: none; border-radius: 3px; }

/* Diff */
.diff { padding: 6px 0; font-size: var(--ui-font-size); line-height: 1.85; }
.dl { display: flex; padding: 0 10px; }
.dg { width: 30px; color: var(--faint); text-align: right; padding-right: 12px; user-select: none; }
.dc { white-space: pre; font-family: var(--mono); }
.del { background: color-mix(in srgb, var(--err) 8%, var(--bg)); }
.del .dc { color: var(--err); }
.add { background: color-mix(in srgb, var(--ok) 8%, var(--bg)); }
.add .dc { color: var(--ok); }

/* Shell */
.body-shell { padding: 10px 12px; }
.shell-cmd {
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 6px 10px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
}
.shell-dollar { color: var(--blue2); font-weight: 700; margin-right: 6px; }
.shell-cwd { font-size: calc(var(--ui-font-size) - 3px); color: var(--muted); margin-top: 5px; font-family: var(--mono); }
.shell-danger {
  margin-top: 6px;
  padding: 5px 10px;
  border: 1px solid var(--err);
  border-radius: 3px;
  color: var(--err);
  font-size: calc(var(--ui-font-size) - 2.5px);
  background: color-mix(in srgb, var(--err) 5%, var(--bg));
}

/* File */
.body-file { overflow: hidden; }
.file-bar {
  padding: 3px 10px;
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
}
.file-lang { letter-spacing: 0.04em; }
.file-content { padding: 6px 0; font-size: calc(var(--ui-font-size) - 2.5px); line-height: 1.7; max-height: 240px; overflow-y: auto; }
.file-line { display: flex; padding: 0 10px; }
.file-ln { width: 30px; color: var(--faint); text-align: right; padding-right: 12px; user-select: none; flex: none; }
.file-text { white-space: pre; font-family: var(--mono); }

/* Chip (fileop/url/search/invocation) */
.body-chip {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--ui-font-size);
}
.chip-label {
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 8px;
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 600;
  color: var(--dim);
  white-space: nowrap;
}
.chip-value {
  font-family: var(--mono);
  color: var(--text);
  word-break: break-all;
}
.chip-detail { font-size: calc(var(--ui-font-size) - 3px); color: var(--muted); }

/* Todo */
.body-todo { padding: 8px 12px; }
.todo-item { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; font-size: calc(var(--ui-font-size) - 1.5px); }
.todo-glyph { color: var(--blue); font-size: var(--ui-font-size-xs); flex: none; width: 14px; }
.todo-title { color: var(--text); }
.todo-done { color: var(--muted); text-decoration: line-through; }

/* Generic */
.body-generic { padding: 10px 12px; font-size: calc(var(--ui-font-size) - 1.5px); color: var(--text); word-break: break-word; }

/* Feedback */
.feedback-wrap {
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.feedback-ta {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 6px 8px;
  border: 1px solid var(--bd);
  border-radius: 3px;
  resize: none;
  outline: none;
  color: var(--text);
  background: var(--bg);
}
.feedback-ta:focus-visible {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 25%, transparent);
}

.feedback-hint { font-size: max(9px, calc(var(--ui-font-size) - 3.5px)); color: var(--faint); margin-top: 4px; }

/* Actions row */
.abtn { display: flex; border-top: 1px solid var(--line); }
.kbtn {
  padding: 8px 14px;
  font-size: calc(var(--ui-font-size) - 2.5px);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  border-right: 1px solid var(--line);
  font-family: var(--mono);
  white-space: nowrap;
  user-select: none;
}
.kbtn:last-child { border-right: none; }
.kbtn:hover { background: var(--panel2); }
.kbtn.pri { background: var(--blue); color: var(--bg); }
.kbtn.pri:hover { background: var(--blue2); }
.k { color: var(--faint); margin-left: 6px; font-size: max(9px, calc(var(--ui-font-size) - 4px)); }
.kbtn.pri .k { color: color-mix(in srgb, var(--bg) 60%, transparent); }

/* =========================================================================
   MOBILE (≤640px): the card spans the full chat column (no 33px left gutter),
   inner previews scroll horizontally instead of overflowing the page, and the
   action buttons become a 2-up grid of ≥44px tall, easily-tappable targets.
   ========================================================================= */
@media (max-width: 640px) {
  .appr {
    margin: 8px 0;
    border-radius: 10px;
  }
  .ah { padding: 9px 12px; }

  /* Diff / file code blocks: scroll sideways for long lines (mono stays pre). */
  .diff,
  .file-content {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .file-content { max-height: 50vh; }

  /* Shell command wraps (already break-all) — give it room. */
  .body-shell,
  .body-chip,
  .body-todo,
  .body-generic { padding: 11px 12px; }

  /* Actions → full-width stacked rows, each a tall ≥44px tap target. The
     primary Approve sits on top; the rest stack below, separated by hairlines.
     Stacking (vs. a cramped 4-up row) keeps every label legible at 360px. */
  .abtn { flex-direction: column; }
  .kbtn {
    min-height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 12px;
    font-size: var(--ui-font-size-sm);
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
  .kbtn:last-child { border-bottom: none; }
  .k { font-size: calc(var(--ui-font-size) - 3px); }
}
</style>
