<script setup lang="ts">
import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import SlashMenu from './SlashMenu.vue';
import MentionMenu from './MentionMenu.vue';
import { formatTokens } from '@moonshot-ai/app-core/lib';
import { placeholderText } from '@moonshot-ai/app-core/lib';
import { useAppearance } from '@moonshot-ai/app-core';
import type { IconName } from '@moonshot-ai/app-client/icons';
import type { FileItem } from './MentionMenu.vue';
import type { ActivationBadges, ConversationStatus, PermissionMode, QueuedPromptView, ToolMedia, TurnAttachment } from '../../types';
import type { AppGoal, AppModel, AppSkill, ThinkingLevel } from '../../api/types';
import {
  commitLevel,
  effectiveThinkingLevel,
  effortLabel,
  isThinkingOn,
  modelThinkingAvailability,
  segmentsFor,
} from '@moonshot-ai/app-core/lib';
import { useInputHistory, useIsMobile } from '@moonshot-ai/app-client/composables';
import { useSlashMenu } from '@moonshot-ai/app-client/composables';
import { useMentionMenu } from '@moonshot-ai/app-client/composables';
import { useComposerDraft } from '@moonshot-ai/app-client/composables';
import { useAttachmentUpload, type Attachment } from '@moonshot-ai/app-client/composables';
import { toPromptAttachment, useKimiWebClient } from '@moonshot-ai/app-client/client';
import { matchBinding } from '../../lib/keymap';
import { resolvedBinding } from '../../composables/useShortcuts';
import {
  attachmentKeyFor,
  createComposerEditor,
  deliverPillEntryPatch,
  newAttId,
  nextAttachmentSeq,
  parseAttachmentLinks,
  registerLiveComposerEditor,
  serializeAttachment,
  startMentionSelectionSync,
  rewriteAttachmentLinksForSubmit,
  type AttachmentEntry,
  type ComposerEditorApi,
} from '@moonshot-ai/app-composer';
import {
  applyEntryPatch,
  buildFileSubmitPayload,
  interleaveSubmitAttachments,
  pillSubmitBlockers,
  decideComposerSubmit,
  planFileAttachment,
  planFolderAttachment,
  restampRefillByOrderHint,
  rewriteQuoteLinks,
  seedEntriesForTurnAttachments,
  steerHistoryText,
  unreferencedSeedFiles,
  type SubmitDecision,
} from '@moonshot-ai/app-client/lib';
import { getKimiWebApi } from '../../api';
import { openUpgrade, NEW_SESSION_SCOPE } from '@moonshot-ai/app-core/lib';
import type { ManagedMembership, PromptAttachment } from '@moonshot-ai/app-client/client';
import { MediaLightbox } from '@moonshot-ai/app-components';
import { MediaThumb } from '@moonshot-ai/app-components';
import { ContextRing, Icon, IconButton, SegmentedControl, Spinner, Tooltip, trackMenuSurface } from '@moonshot-ai/app-ui';

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = withDefaults(defineProps<{
  running?: boolean;
  /** Main turn in flight — the Stop button's condition (Esc shares it).
   *  Background-only work keeps Stop hidden; those tasks cancel from the dock. */
  working?: boolean;
  /** True while the empty-composer first prompt is being created + submitted.
   *  Disables the textarea and swaps the send button for a spinner. */
  starting?: boolean;
  /** Active session id — scopes the persisted unsent draft (per session). */
  sessionId?: string;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  /** If undefined, attach button is hidden and paste/drag are no-ops. */
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  /** Status data (model, context, permission) — drives the bottom toolbar. */
  status?: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  /** The user's not-yet-cashed plan intent (armed): "the next send enters
      plan mode". Shown as the in-input directive pill; the daemon-fact plan
      mode rides the dock workbar instead. */
  planArmed?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  goal?: AppGoal | null;
  activationBadges?: ActivationBadges;
  /** Available models for the quick-switch dropdown. */
  models?: AppModel[];
  /** Daemon auth/provider readiness (GET /auth ready). When explicitly false
      and the catalog is also empty, the model pill slot shows a sign-in
      entry — an empty catalog alone may just be a failed /models fetch. */
  authReady?: boolean;
  /** Whether the managed Kimi account is signed in. A signed-in account never
      gets the sign-in entry, even with no usable models. */
  managedSignedIn?: boolean;
  /** Membership of the signed-in managed account; 'free' swaps the model pill
      slot for the upgrade entry when no models are usable. */
  managedMembership?: ManagedMembership;
  /** Starred model ids shown at the top of the quick-switch dropdown. */
  starredIds?: string[];
  /** Session skills shown in the `/` menu (after the built-in commands). */
  skills?: AppSkill[];
  /** Whether the session skill list finished loading. Only once loaded can a
      revived pill's name be verified — see the submit path's stale-skill
      degradation. */
  skillsLoaded?: boolean;
  /** Hide the context-usage indicator (used on the empty-session landing page). */
  hideContext?: boolean;
}>(), {
  running: false,
  working: false,
  starting: false,
  queued: () => [],
  searchFiles: undefined,
  uploadImage: undefined,
  models: () => [],
  starredIds: () => [],
  skills: () => [],
  skillsLoaded: false,
});

const isMobile = useIsMobile();

const placeholder = computed(() =>
  props.starting
    ? t('composer.starting')
    : props.running
      // No keyboard on mobile — drop the Ctrl+S steer hint from the copy.
      ? t(isMobile.value ? 'composer.placeholderRunningMobile' : 'composer.placeholderRunning')
      : props.goalMode
        ? t('status.goalPlaceholder')
        // The plan hint rides the intent too: armed (not yet sent) shows the
        // plan prompt, exactly like the daemon-fact active mode.
        : props.planArmed || props.planMode
          ? t('status.planPlaceholder')
          : t('composer.placeholder')
);

const emit = defineEmits<{
  /** `restoreText` + `restoreEntries` are the gate-failure restore's draft
      (the PRE-REWRITE text, attId links intact, with the original registry
      entries) — see the command emit's contract. */
  submit: [payload: { text: string; restoreText: string; editText: string; attachments: PromptAttachment[]; restoreEntries: AttachmentEntry[] }];
  /** Steer the composer text (+ any queued prompts, merged by the parent)
      into the RUNNING turn — TUI ctrl+s. */
  steer: [payload: { text: string; attachments: PromptAttachment[] }];
  /** Slash command. Only skill commands carry the composer's attachments
      (the pills/chips are consumed with the command); built-in commands
      carry none — their pills are re-seeded into the cleared composer so the
      attachments stay pending. `restoreText` is the PRE-REWRITE draft a
      gate-failure restore loads back (every pill's attId link intact — the
      rewrite would have degraded a folder pill into a plain path mention);
      `restoreEntries` pairs it with the original registry entries (folder
      paths included), or the revived pills would come back dead. */
  command: [payload: { cmd: string; attachments: PromptAttachment[]; restoreText?: string; skillName?: string; restoreEntries?: AttachmentEntry[]; editText?: string }];
  interrupt: [];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleSwarm: [];
  toggleGoal: [];
  createGoal: [objective: string];
  controlGoal: [action: 'pause' | 'resume' | 'cancel'];
  focusGoal: [];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
  /** Signed out / no models — the model pill slot becomes a sign-in entry. */
  login: [];
}>();

const { t, locale } = useI18n();
// The client facade's `notify` surfaces the invalid-command notice locally
// (WarningToasts) — no daemon round-trip for a command usage error.
const client = useKimiWebClient();

// ---------------------------------------------------------------------------
// Text state + per-session draft persistence — see useComposerDraft. The
// attachment-entry sidecar (loadDraftAttachments/saveDraftAttachments) backs
// the file/folder pill registry below.
// ---------------------------------------------------------------------------
const { text, editorRef, loadForEdit, clearDraft, loadDraftAttachments, saveDraftAttachments, saveDraft } = useComposerDraft({
  sessionId: () => props.sessionId,
  onBeforeSessionSave: (sid) => {
    // A mid-browse switch must not persist the RECALL text and the wiped
    // registry as the outgoing session's draft — restore before the save.
    restoreBrowsingDraftForDeparture(sid);
  },
});

// ---------------------------------------------------------------------------
// Attachment pill registry bridge: the editor's registry plugin is the source
// of truth for file/folder pill metadata (path/size/upload state/fileId).
// This ref mirrors it for the reactive UI (canSend, the send gate), and every
// movement is persisted to the session's draft sidecar, so a restart re-seeds
// the entries behind the revived draft's pills.
// ---------------------------------------------------------------------------
const attachmentEntries = ref<AttachmentEntry[]>([]);

/** The draft's attachment entries snapshotted when history browsing starts
 *  (see the ArrowUp/ArrowDown branch in handleKeydown) — the recall
 *  rebuilds drop them from the registry and the sidecar, and this is what
 *  re-seeds them on the walk back to the live draft (or on a mid-browse
 *  session switch). Cleared when the browse is ABANDONED without a walk
 *  home — see resetHistoryBrowse. */
let historyEntrySnapshot: AttachmentEntry[] | null = null;

/** Leave history browsing WITHOUT walking home (typing, a drop/adoption, or
 *  a submit of the recalled text): the pre-browse draft is deliberately
 *  abandoned, so its entry snapshot must go with it — a stale snapshot
 *  would otherwise be persisted over the CURRENT draft's sidecar by the
 *  session-switch restore (onBeforeSessionSave), replacing the entries of
 *  pills added since and blocking the send gate with missing entries after
 *  a refresh. */
function resetHistoryBrowse(): void {
  history.resetBrowsing();
  historyEntrySnapshot = null;
}

/** Restore a mid-browse draft for a DEPARTURE (a session switch's
 *  onBeforeSessionSave, or the component unmount): walk the browse home
 *  (useInputHistory's own session watcher may already have — the loop is
 *  the backstop for either watcher order), then persist the restored text
 *  and the browse-time entry snapshot, and sync the EDITOR now — its
 *  text-watcher rebuild would come too late (a departure stashes the
 *  editor state in this same flush, and on unmount the watchers are
 *  already dead), so without the sync the departure captures the recall
 *  doc and the wiped registry, masking the whole restore on the way back. */
function restoreBrowsingDraftForDeparture(sid: string | undefined): void {
  while (history.isBrowsing()) history.recallNewer();
  if (historyEntrySnapshot !== null) {
    saveDraft(sid, text.value);
    saveDraftAttachments(sid, historyEntrySnapshot);
    editor?.setText(text.value, { entries: historyEntrySnapshot });
    historyEntrySnapshot = null;
  }
}

function handleRegistryChange(entries: AttachmentEntry[]): void {
  attachmentEntries.value = entries;
  saveDraftAttachments(props.sessionId, entries);
}

/** Synchronously clear the persisted attachment sidecar — same unmount race
 *  as clearDraft (the composer may unmount before the post-clear registry
 *  notification flushes), so send/steer call this alongside clearDraft. */
function clearDraftAttachments(): void {
  saveDraftAttachments(props.sessionId, []);
}

// ---------------------------------------------------------------------------
// ProseMirror editing surface — see app-client's composerEditor. The host div
// carries the .ph styling; the EditorView mounts inside it. The text model
// stays a plain-string ref: user edits flow OUT via onChange, external writes
// (draft load, history recall, mention select, submit clear) flow IN via the
// watcher below, which skips editor-originated changes by comparing text.
// ---------------------------------------------------------------------------
const editorHostRef = ref<HTMLElement | null>(null);
let editor: ComposerEditorApi | null = null;
let stopMentionSelectionSync: (() => void) | null = null;
/** Release for this editor's live-delivery registration (see
 *  registerLiveComposerEditor) — re-armed on every session restore. */
let releaseLiveRegistration: (() => void) | null = null;

onMounted(() => {
  const host = editorHostRef.value;
  if (!host) return;
  editor = createComposerEditor(host, {
    initialText: text.value,
    onChange: (value) => {
      text.value = value;
      handleInput();
    },
    handleKeyDown: (e) => handleKeydown(e),
    onBlur: handleEditorBlur,
    onWorkModeDismiss: clearWorkMode,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    attachments: {
      initialEntries: loadDraftAttachments(props.sessionId),
      onRegistryChange: handleRegistryChange,
    },
  });
  editor.setEditable(!props.starting);
  editorRef.value = editor;
  // Browsers don't selection-paint an inline svg glyph — mark covered pills
  // with a class instead (see mentionSelectionSync).
  stopMentionSelectionSync = startMentionSelectionSync(() => editorHostRef.value);

  // The armed work mode renders as the editor's leading pill (a widget
  // decoration at the document head — never document content, so the wire
  // text is untouched); the × calls back into clearWorkMode. Re-pushed on
  // mode / locale changes so the pill's label follows the locale.
  watchEffect(() => {
    editor?.setWorkMode(
      workMode.value
        ? {
            mode: workMode.value,
            label: workMode.value === 'goal' ? t('status.goalLabel') : t('status.planLabel'),
            dismissLabel: t('status.workModeDismiss'),
          }
        : null,
    );
  });
  // The empty-doc placeholder is an editor decoration too, so it can share
  // the first line with the work-mode pill.
  watchEffect(() => {
    editor?.setPlaceholder(placeholder.value);
  });

  // Restore the session's stashed state, falling back to the persisted
  // draft. If the two ever diverge (e.g. localStorage lost the draft
  // mid-run), the stashed state is the fresher truth — push it back into the
  // text ref so data-empty/canSend/submit stay consistent with the visible
  // doc (the draft watcher then re-persists it, healing the divergence).
  function restoreSessionState(sid: string): void {
    if (!editor) return;
    if (editor.restoreState(sid)) {
      const restored = editor.getText();
      if (restored !== text.value) text.value = restored;
    } else {
      // Nothing stashed for this session — plain text load (fresh stack),
      // exactly what the text watcher would do anyway. setText re-inits the
      // registry from the PASSED entries (never the mount session's), so the
      // rebuild lands THIS session's sidecar atomically.
      editor.setText(text.value, { entries: loadDraftAttachments(sid) });
    }
    // Keep the reactive mirror in sync even when nothing fired (a restore
    // whose registry is identity-equal to the previous one doesn't notify).
    attachmentEntries.value = editor.getAttachmentEntries();
    // This editor now OWNS the session: register it as the live delivery
    // target for async upload outcomes (see registerLiveComposerEditor) — a
    // completion callback whose own composer instance is gone (unmounted by
    // a question/approval, then remounted) must still reach it.
    releaseLiveRegistration?.();
    releaseLiveRegistration = registerLiveComposerEditor(sid, editor);
  }

  // A remount for the same session (empty-session ↔ docked composer swap)
  // gets its stashed state back, undo stack included; first-ever mount finds
  // nothing and keeps the draft text.
  if (props.sessionId) restoreSessionState(props.sessionId);
  else {
    // The empty-session (landing page) composer registers under the shared
    // '__new__' scope too: an upload outcome must reach THIS editor live —
    // a sidecar-only delivery would leave its entry stuck on `uploading`,
    // the first message blocked by the send gate until a remount.
    releaseLiveRegistration = registerLiveComposerEditor(NEW_SESSION_SCOPE, editor);
  }
  // The registry may already hold entries from initialEntries (a restored
  // draft's sidecar) — onRegistryChange only fires on later CHANGES, and the
  // landing composer (no sessionId) never reaches restoreSessionState, so
  // without this the mirror stays empty and a restored draft would submit
  // with its pills silently degraded (empty payload, bare-name links).
  attachmentEntries.value = editor.getAttachmentEntries();
  // File drafts hydrated before the editor existed adopt as pills now.
  if (pendingFileAdoptions.length > 0) {
    for (const att of pendingFileAdoptions) adoptFileAttachment(att);
    pendingFileAdoptions.length = 0;
  }

  // Session switching swaps the WHOLE editor state: stash the old session's
  // state (doc + selection + undo stack) and adopt the new one's. Registered
  // BEFORE the text watcher — the draft composable's session watcher has
  // already loaded the new draft into `text` when this runs, and after a
  // restore the texts match, so the text watcher below skips its setText
  // (which would reset the freshly restored undo stack).
  watch(
    () => props.sessionId,
    (newSid, oldSid) => {
      if (!editor || newSid === oldSid) return;
      // The empty-session composer (no sid yet) is never stashed: its first
      // prompt becomes a brand-new session with no undo carry-over.
      if (oldSid) editor.stashState(oldSid);
      if (newSid) restoreSessionState(newSid);
      else {
        // The empty-session composer (its draft lives under the '__new__'
        // keys) is never stashed — same setText-with-entries rebuild as the
        // no-stash path of restoreSessionState. It registers under the same
        // '__new__' scope as the landing-page composer (token handoff), so
        // upload outcomes keep landing live.
        releaseLiveRegistration?.();
        releaseLiveRegistration = registerLiveComposerEditor(NEW_SESSION_SCOPE, editor);
        editor.setText(text.value, { entries: loadDraftAttachments(undefined) });
        attachmentEntries.value = editor.getAttachmentEntries();
      }
      // Chip-era FILE drafts of the new session adopt as pills only NOW: the
      // upload composable's session watcher (registered earlier, in setup)
      // defers them for exactly this point — adopting any earlier would
      // insert the pills into the OLD session's still-live editor.
      adoptStoredFileDrafts();
    },
  );

  // External text writes flow into the editor here. Registered on mount (not
  // in setup) so it can see the editor handle; flush order guarantees this
  // runs before the nextTick caret placement in the composables.
  watch(text, (value) => {
    // External writes within THIS session (history recall, queue/edit
    // refills, the mobile mention sheet's token rewriting): the rebuild
    // must carry the CURRENT registry entries — a bare setText resets the
    // registry to EMPTY (its cross-session default), and the change-notify
    // would persist the wipe to this session's sidecar, silently stripping
    // every revived pill's fileId (they degrade to bare names on submit).
    // The rebuild's init reconcile still drops anything the new text no
    // longer references (a submit clear empties it as before).
    if (editor && value !== editor.getText()) {
      editor.setText(value, { entries: editor.getAttachmentEntries() });
    }
  });

  // `starting` disables the field while the first prompt is being submitted.
  watch(
    () => props.starting,
    (starting) => editor?.setEditable(!starting),
  );

  // Combobox semantics for the slash/mention menus live on the focusable PM
  // root (the textarea used to carry them in template bindings). The
  // localized placeholder doubles as the accessible name — the placeholder
  // decoration is aria-hidden, and the label takes the tag-stripped plain
  // form (the copy may carry <kbd> keycap markup).
  watchEffect(() => {
    const dom = editor?.dom;
    if (!dom) return;
    dom.setAttribute('aria-label', placeholderText(placeholder.value));
    dom.setAttribute('aria-expanded', String(!!menuAriaControls.value));
    const controls = menuAriaControls.value;
    if (controls) dom.setAttribute('aria-controls', controls);
    else dom.removeAttribute('aria-controls');
    const activeDescendant = menuAriaActiveDescendant.value;
    if (activeDescendant) dom.setAttribute('aria-activedescendant', activeDescendant);
    else dom.removeAttribute('aria-activedescendant');
  });
});

onUnmounted(() => {
  // A mid-browse unmount (e.g. a question/approval card swaps this composer
  // out) restores the pre-browse draft FIRST — otherwise the stash below
  // captures the recall doc and the wiped registry, the in-memory snapshot
  // dies with the component, and the next mount resurrects the wrong state.
  restoreBrowsingDraftForDeparture(props.sessionId);
  // Keep the session's state (undo stack included) across composer remounts —
  // the empty-session and docked composers are separate instances. Sync the
  // text ref into the editor FIRST: an optimistic send clears `text` and
  // swaps this component out within the same flush, so the pre-flush text
  // watcher may never run — without the sync we'd stash a state still
  // holding the just-sent prompt and resurrect it on the next mount.
  if (editor && props.sessionId) {
    // Same-session rebuild (see the text watcher above): carry the current
    // entries so the registry survives — the init reconcile drops what the
    // cleared text no longer references anyway.
    if (text.value !== editor.getText()) {
      editor.setText(text.value, { entries: editor.getAttachmentEntries() });
    }
    editor.stashState(props.sessionId);
  }
  releaseLiveRegistration?.();
  releaseLiveRegistration = null;
  stopMentionSelectionSync?.();
  editor?.destroy();
  editor = null;
  editorRef.value = null;
});

// ---------------------------------------------------------------------------
// Expanded editor — a taller, multi-line composing mode. While expanded, Enter
// inserts a newline instead of sending (send via the button or Cmd/Ctrl+Enter);
// it auto-collapses after a successful send. See handleKeydown / handleSubmit.
// ---------------------------------------------------------------------------
const expanded = ref(false);
function toggleExpand(): void {
  expanded.value = !expanded.value;
  // Re-measure growth against the *post-toggle* resting height. Without this,
  // collapsing would keep the isGrown measured against the expanded 70%-of-app-height
  // min-height, hiding the toggle even though the collapsed draft is still
  // multi-line. (This does not affect the expanded state itself — once
  // expanded, it stays at that height until toggled back or sent.)
  void nextTick(() => {
    recomputeGrown();
    // Return focus to the editor so the user can keep typing right away;
    // otherwise focus stays on the toggle button and the next Enter would
    // activate it again instead of inserting a newline.
    editor?.focus();
  });
}

// Collapse the expanded editor after a successful send/steer. On image-only
// sends the text is already empty, so nothing else re-measures the box —
// without this the collapsed cap (1/4 viewport) leaves an oversized empty box
// until the next keystroke.
function collapseAndRefit(): void {
  if (!expanded.value) return;
  expanded.value = false;
  void nextTick(recomputeGrown);
}

// The expand toggle is hidden at the resting height and only appears once the
// box has grown past it (multi-line content) — keeps the empty composer
// uncluttered. While expanded it always shows so the user can collapse back.
//
// The resting height equals the host's computed `min-height` (set in
// style.css). We read it from the element instead of hard-coding.
const RESTING_HEIGHT_FALLBACK_PX = 36;
function restingHeightPx(el: HTMLElement): number {
  if (typeof getComputedStyle === 'undefined') return RESTING_HEIGHT_FALLBACK_PX;
  const min = Number.parseFloat(getComputedStyle(el).minHeight);
  return Number.isFinite(min) && min > 0 ? min : RESTING_HEIGHT_FALLBACK_PX;
}
const isGrown = ref(false);
function recomputeGrown(): void {
  const el = editorHostRef.value;
  isGrown.value = !!el && el.scrollHeight > restingHeightPx(el);
}
watch(text, () => {
  void nextTick(recomputeGrown);
});

// ---------------------------------------------------------------------------
// Sent-message history recall (shell-style ↑/↓). See useInputHistory for the
// implementation; the composer keeps the keydown orchestration (which also
// juggles the slash and mention menus).
// ---------------------------------------------------------------------------
const history = useInputHistory({ text, editorRef, sessionId: () => props.sessionId });

// ---------------------------------------------------------------------------
// Slash-command menu — see useSlashMenu for the implementation. The composer
// keeps the keydown orchestration (arrow keys / Enter / Escape) because it also
// juggles the mention menu and history recall.
// ---------------------------------------------------------------------------
// Arm/disarm the primary work mode. Shared by the typed `/plan` and `/goal`
// commands and the slash menu's selection path, so both arming routes behave
// identically.
function armPlanMode(): void {
  // Enable-only: selecting /plan while plan is already on must NOT toggle it
  // off — the pill's × is the only exit (same contract as the add menu).
  if (planOn.value) return;
  if (props.goalMode) emit('toggleGoal');
  emit('togglePlan');
}
function armGoalMode(): void {
  // A live goal owns the mode — focus its panel instead of arming a new one.
  if (goalActive.value) {
    emit('focusGoal');
    return;
  }
  // Enable-only, same as above.
  if (props.goalMode) return;
  if (planOn.value) emit('togglePlan');
  emit('toggleGoal');
}

const {
  open: slashOpen,
  items: slashItems,
  ranges: slashRanges,
  active: slashActive,
  update: updateSlashMenu,
  select: selectSlashCommand,
} = useSlashMenu({
  text,
  editorRef,
  skills: () => props.skills,
  // Menu-selected bare commands never carry attachments (skills all take
  // `acceptsInput`, so they leave the command in the composer instead of
  // firing; any pending chips stay put for the eventual submit).
  emitCommand: (cmd) => {
    if (cmd === '/plan') {
      armPlanMode();
      return;
    }
    if (cmd === '/goal') {
      armGoalMode();
      return;
    }
    if (cmd === '/swarm') {
      // A menu-picked /swarm arms the toggle (enable-only — the chip's × is
      // the off switch). Typed `/swarm <task>` still travels as a command.
      if (!swarmOn.value) emit('toggleSwarm');
      return;
    }
    emit('command', { cmd, attachments: [] });
  },
  historyPush: (entry) => history.push(entry),
  clearDraft,
  // Built-in descs are i18n keys — resolve them so filtering (and its pinyin
  // matching) works over display text.
  resolveDesc: (item) => (item.isSkill ? item.desc : t(item.desc)),
});

// The `/token` text driving the slash menu — passed down so matches in the
// command names can be highlighted.
const slashQuery = computed(() =>
  text.value.startsWith('/') && !text.value.includes(' ') ? text.value.slice(1) : '',
);

// Combobox semantics for the three autocomplete menus (slash / mention / add):
// the textarea keeps focus while the menus are open, so it must advertise
// expansion, the open menu, and the active row for assistive tech.
const menuAriaControls = computed(() => {
  if (slashOpen.value) return 'composer-slash-menu';
  if (mentionOpen.value) return 'composer-mention-menu';
  return undefined;
});
const menuAriaActiveDescendant = computed(() => {
  if (slashOpen.value && slashItems.value.length > 0) return `composer-slash-option-${slashActive.value}`;
  // The rows stay mounted while a new search loads (only the EMPTY menu swaps
  // to its full-area loading branch), so the active row keeps a valid target.
  if (mentionOpen.value && mentionItems.value.length > 0) return `composer-mention-option-${mentionActive.value}`;
  return undefined;
});

// ---------------------------------------------------------------------------
// @-mention menu — see useMentionMenu for the implementation. The composer
// keeps the keydown orchestration because it also juggles the slash menu and
// history recall.
// ---------------------------------------------------------------------------
const {
  open: mentionOpen,
  items: mentionItems,
  active: mentionActive,
  loading: mentionLoading,
  fileStale: mentionFileStale,
  update: updateMentionMenu,
  close: closeMentionMenu,
  select: selectMentionItem,
  navigate: mentionNavigate,
} = useMentionMenu({
  text,
  editorRef,
  searchFiles: () => props.searchFiles,
  skills: () => props.skills,
  // Pill insertion — replaces the @token with a mention atom (the plain-text
  // splice fallback in the composable is the web textarea's path).
  insertMention: (entry, range) => {
    editor?.insertMention(
      entry.kind === 'skill'
        ? { kind: 'skill', name: entry.name, path: '' }
        : { kind: entry.kind, name: entry.name, path: entry.path },
      range,
    );
  },
});

// The slash / mention autocomplete popups are menu surfaces too: while one is
// open, tooltips outside it hide (native behavior — the add/permission/model
// popups below register the same way).
const slashMenuRef = ref<InstanceType<typeof SlashMenu> | null>(null);
const mentionMenuRef = ref<InstanceType<typeof MentionMenu> | null>(null);
const slashMenuEl = computed(() => slashMenuRef.value?.el ?? null);
const mentionMenuEl = computed(() => mentionMenuRef.value?.el ?? null);
trackMenuSurface(slashOpen, slashMenuEl);
trackMenuSurface(mentionOpen, mentionMenuEl);

// The component instance is reused across session switches (it is not keyed by
// session), so reset per-session UI state when the active session changes:
// - the expanded preference, or one chat's tall editor (Enter = newline)
//   would leak into the next session;
// - the autocomplete menus, which belong to the focused editing session —
//   clicking the sidebar already closes them via the editor's blur; this is
//   the backstop for switches that never touch the composer (keyboard
//   shortcuts, programmatic switches). Typing reopens them via handleInput.
watch(() => props.sessionId, () => {
  expanded.value = false;
  slashOpen.value = false;
  closeMentionMenu();
});

// Losing focus closes the autocomplete menus (VS Code suggest / Notion
// slash-menu behavior). Menu rows use mousedown.prevent and the scroll thumb
// prevents pointerdown, so interacting with an open menu never blurs the
// editor. Refocusing does not reopen a menu — the next keystroke re-derives
// it from the live text via handleInput.
function handleEditorBlur(): void {
  slashOpen.value = false;
  closeMentionMenu();
}

// ---------------------------------------------------------------------------
// Input event handler — updates both menus
// ---------------------------------------------------------------------------

function handleInput(): void {
  // Manual typing leaves history-browsing mode — the text is now a fresh draft.
  resetHistoryBrowse();
  updateSlashMenu();
  updateMentionMenu();
  // Popups are exclusive: a freshly opened slash/mention menu displaces the
  // add menu (the textarea kept focus when it was opened by mouse). ANY real
  // typing closes it too — the add menu has no typeahead, so leaving it open
  // would keep Enter and the arrow keys captured by its rows while the user
  // writes (an accidental File/Goal pick instead of a send).
  if (slashOpen.value || mentionOpen.value || addMenuOpen.value) closeAddMenu();
}

// ---------------------------------------------------------------------------
// Dropped/pasted folders → in-document folder pills (folders are never
// uploaded — the upload endpoint rejects them; useAttachmentUpload routes
// their bridge-resolved paths here).
// ---------------------------------------------------------------------------
function insertFolderPaths(paths: string[]): void {
  const ed = editor;
  // The draft changed without typing — leave history-browsing mode like
  // handleInput does, or the next ↑ would replace it with a history entry.
  resetHistoryBrowse();
  if (!ed) return; // The editor mounts with the card, so drops always find it.
  // A drop/paste usually lands while the editor is unfocused and its selection
  // is stale — append at the end unless the caret is genuinely live.
  let firstPos: number | undefined =
    document.activeElement === ed.dom ? (ed.selectionStart ?? undefined) : ed.getText().length;
  for (const path of paths) {
    const plan = planFolderAttachment(attachmentEntries.value, path);
    // Pill BEFORE entry — the registry is doc-reconciled, so an entry whose
    // pill isn't in the doc yet would be dropped by the insert's reconcile.
    // Only the first pill uses the computed position; each later one lands at
    // the caret the previous insert left behind (keeping the paths' order).
    ed.insertAttachment({ attId: plan.attId, name: plan.name, kind: 'folder' }, firstPos);
    firstPos = undefined;
    if (plan.entry) ed.upsertAttachmentEntry(plan.entry);
  }
  // The drop is not typing, so close any popup the onChange-derived menu
  // update may have opened (an absolute dropped path reads as a `/token`).
  slashOpen.value = false;
  closeMentionMenu();
}

// ---------------------------------------------------------------------------
// File pill entry (drop/paste/picker, routed in by the useAttachmentUpload
// seam): a non-media file becomes an in-document attachment pill; the upload
// still runs in the background and backfills the entry's fileId. Returns
// false to fall back to the old chip path (defensive — the seam is wired
// only when the editor and an uploader both exist). `seq` is the batch's
// pre-assigned add-order stamp (see routeFiles), forwarded to the plan so
// one batch's files and media interleave by selection order.
// ---------------------------------------------------------------------------
function insertFileAttachment(file: File, path: string | null, at?: { clientX: number; clientY: number }, seq?: number): boolean {
  const ed = editor;
  const upload = props.uploadImage;
  if (!ed || !upload) return false;
  // Drop → the pill lands at the drop point (a window-level drop that misses
  // the editor falls back to the end of the text); picker/paste → a POINT
  // insertion at the live caret (same rule as insertFolderPaths — the current
  // selection is never replaced, so pasting a file can't silently delete
  // selected text), or the end when the editor isn't focused.
  let pos: number | undefined;
  if (at) pos = ed.textOffsetAtCoords({ left: at.clientX, top: at.clientY }) ?? ed.getText().length;
  else pos = document.activeElement === ed.dom ? (ed.selectionStart ?? undefined) : ed.getText().length;
  const plan = planFileAttachment(attachmentEntries.value, { name: file.name, size: file.size, path, mediaType: file.type || undefined, lastModified: file.lastModified || undefined, seq });
  if (plan.entry) {
    // Pill BEFORE entry (same doc-reconcile invariant as the folder path).
    ed.insertAttachment({ attId: plan.attId, name: file.name, kind: 'file' }, pos);
    ed.upsertAttachmentEntry(plan.entry);
  } else if (plan.startUpload) {
    // Restarting a dead upload (failed/interrupted) or a changed file's
    // re-upload on an entry the doc ALREADY references: the existing pill IS
    // the attachment — do NOT insert another node, or every retry appends a
    // duplicate inline reference (and repeated failures would pile them up).
    // Just revive the entry with the new version; its pill clears the error
    // state via the registry-driven decoration.
    ed.updateAttachmentEntry(plan.attId, { uploading: true, error: undefined, size: file.size, mediaType: file.type || undefined, lastModified: file.lastModified || undefined });
  } else {
    // A same-version reuse (ready, or still in flight): a deliberate SECOND
    // reference — many pills may share one entry's file on purpose (the
    // plan's startUpload stays false, so nothing re-uploads).
    ed.insertAttachment({ attId: plan.attId, name: file.name, kind: 'file' }, pos);
  }
  if (plan.startUpload) {
    // Capture the session at upload time; the async completion must patch
    // THAT session's registry even if the user has since switched away (the
    // chip path keys its pending list by session for the same reason).
    const sid = props.sessionId;
    void upload(file, file.name).then((result) => {
      // The server's mediaType wins over File.type on the backfill. The
      // success patch also CLEARS any error: a pill cut and pasted back
      // mid-upload comes back normalized to 'upload-interrupted' (the
      // clipboard flavor's recovery default), but the original upload still
      // completes against the same sid+attId — its backfill must retire
      // that marker too, or the revived pill would block the send gate
      // forever. (Accepted gap: an upload that completes BETWEEN cut and
      // paste patches a dropped entry and is lost — the pill keeps the
      // interrupted marker and the user re-drops to retry.)
      patchPillEntry(sid, plan.attId, result ? { fileId: result.fileId, mediaType: result.mediaType, uploading: false, error: undefined } : { uploading: false, error: 'upload-failed' });
    }).catch(() => {
      patchPillEntry(sid, plan.attId, { uploading: false, error: 'upload-failed' });
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// LEGACY (transitional, safe to delete later) — chip-era file adoption:
// a rehydrated chip-era file draft (useAttachmentUpload's hydrateDraft seam)
// or an edit&resend refill the revived doc doesn't reference becomes an
// in-document pill — its fileId is reused, no re-upload. The strip renders
// media only, so a file that came back as a chip would be invisible (and
// would keep re-persisting as one). Delete this function, the buffer below,
// its flush in onMounted, the hydrateDraft partition in useAttachmentUpload,
// and the adopt fallback in loadAttachmentsForEdit once chip-era
// drafts/history no longer matter (see the LEGACY note on
// AttachmentUploadDeps.adoptFileAttachment).
// ---------------------------------------------------------------------------
const pendingFileAdoptions: TurnAttachment[] = [];

function adoptFileAttachment(att: TurnAttachment, seq?: number, at?: number): void {
  const ed = editor;
  if (!att.fileId) return;
  if (!ed) {
    // useAttachmentUpload hydrates drafts during its own setup — BEFORE the
    // editor exists (first mount only). Buffer and flush right after mount.
    pendingFileAdoptions.push(att);
    return;
  }
  // The draft changed without typing — leave history-browsing mode (same as
  // insertFolderPaths).
  resetHistoryBrowse();
  const attId = newAttId();
  let pos: number;
  if (at !== undefined) {
    // Ordinal-anchored insert (the edit&resend refill): land BEFORE the
    // anchor pill, space-separated. Insert the separator first so the pill
    // takes the anchor's offset — the text before the anchor already
    // separates the pair on the left (see loadAttachmentsForEdit).
    ed.insertTextAt(at, ' ');
    pos = at;
  } else {
    // Append at the end of the draft (a restore has no live caret), separated
    // from preceding text that isn't whitespace-terminated.
    const text = ed.getText();
    pos = text.length;
    if (pos > 0 && !/\s/.test(text.charAt(pos - 1))) {
      ed.insertTextAt(pos, ' ');
      pos += 1;
    }
  }
  // Pill BEFORE entry — the registry is doc-reconciled.
  ed.insertAttachment({ attId, name: att.name ?? 'file', kind: 'file' }, pos);
  ed.upsertAttachmentEntry({
    attId,
    key: attachmentKeyFor({ kind: 'file', attId }),
    kind: 'file',
    name: att.name ?? 'file',
    size: att.size,
    mediaType: att.mediaType,
    seq: seq ?? nextAttachmentSeq(),
    refCount: 0,
    uploading: false,
    fileId: att.fileId,
  });
}

/** Apply an upload-outcome patch to a pill entry, session-switch and
 *  remount safe — every session routes through deliverPillEntryPatch: the
 *  LIVE editor registered for the session (this composer, or a remount that
 *  adopted the session after an unmount consumed the stash), else the
 *  session's stashed editor state (mirrored to the sidecar), else the
 *  sidecar itself. The empty session joins the same delivery under the
 *  shared NEW_SESSION_SCOPE key — its live editor (the landing-page
 *  composer, or a docked one switched to it) takes the outcome when
 *  mounted, the sidecar otherwise. */
function patchPillEntry(
  sid: string | undefined,
  attId: string,
  patch: Parameters<ComposerEditorApi['updateAttachmentEntry']>[1],
): void {
  deliverPillEntryPatch(sid ?? NEW_SESSION_SCOPE, attId, patch, {
    loadEntries: () => loadDraftAttachments(sid),
    saveEntries: (entries) => saveDraftAttachments(sid, entries),
  });
  // An upload completing mid history-browse: the walk-back restores from
  // historyEntrySnapshot, so patch it too — otherwise the draft comes back
  // stuck on the pre-completion state (uploading forever, blocked from
  // sending), the completed fileId lost.
  if (historyEntrySnapshot !== null) {
    historyEntrySnapshot = applyEntryPatch(historyEntrySnapshot, attId, patch);
  }
}

// ---------------------------------------------------------------------------
// Attachments — see useAttachmentUpload. Media (image/video) keeps the chip
// strip below; non-media files route through the insertFileAttachment seam
// into in-document pills (and folders through insertFolderPaths). The
// composer keeps handleSubmit / handleSteer (which read the attachments to
// build the payload) and the `hasUpload` toolbar flag.
// ---------------------------------------------------------------------------
const {
  attachments,
  previewAttachment,
  fileInputRef,
  isDragOver,
  removeAttachment,
  openAttachmentPreview,
  closeAttachmentPreview,
  openFilePicker,
  handleFileInputChange,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  clearAfterSubmit,
  clearAttachments,
  loadAttachments,
  adoptStoredFileDrafts,
} = useAttachmentUpload({
  api: getKimiWebApi(),
  uploadImage: () => props.uploadImage,
  sessionId: () => props.sessionId,
  insertFolderPaths,
  insertFileAttachment,
  adoptFileAttachment,
});

// Silence noUnusedLocals: fileInputRef is used as a template ref (ref="fileInputRef").
void fileInputRef;

// The strip is media-only: files live in the document as pills now.
type MediaDraft = Attachment & { kind: 'image' | 'video' };
const isMediaDraft = (att: Attachment): att is MediaDraft => att.kind === 'image' || att.kind === 'video';
const mediaDrafts = computed(() => attachments.value.filter(isMediaDraft));

// Overflow handling for the capped strip: a count badge while the rows
// scroll, and new attachments auto-scroll into view (removals keep position).
const attScrollRef = ref<HTMLElement | null>(null);
const attScrollContentRef = ref<HTMLElement | null>(null);
const attOverflowing = ref(false);

// Measure the CONTENT wrapper, not the scroll container: the is-overflowing
// bottom padding feeds back into scrollHeight and would latch the badge on.
function updateAttOverflow(): void {
  const el = attScrollRef.value;
  const content = attScrollContentRef.value;
  attOverflowing.value = el !== null && content !== null && content.scrollHeight > el.clientHeight + 1;
}

let attOverflowObserver: ResizeObserver | null = null;
watch(
  attScrollRef,
  (el) => {
    attOverflowObserver?.disconnect();
    attOverflowObserver = null;
    if (el) {
      const observer = new ResizeObserver(updateAttOverflow);
      observer.observe(el);
      attOverflowObserver = observer;
    }
    updateAttOverflow();
  },
  { immediate: true },
);
watch(attachments, () => void nextTick(updateAttOverflow), { deep: true });
onUnmounted(() => attOverflowObserver?.disconnect());

// Reveal the NEWEST attachment on add: scroll the strip to the bottom when
// the media row grows (removals keep position).
watch(
  () => mediaDrafts.value.length,
  (media, prevMedia) => {
    if (media <= prevMedia) return;
    void nextTick(() => {
      const el = attScrollRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

onMounted(() => {
  // Reflect the grown state of a restored draft on first render so the expand
  // toggle shows for an already-long draft. (The PM editor grows the box to
  // fit its content on its own — no explicit re-fit needed here.)
  if (text.value) {
    void nextTick(recomputeGrown);
  }
});

onUnmounted(() => {
  clearCompositionEndTimer();
});

// ---------------------------------------------------------------------------
// Submit / keydown
// ---------------------------------------------------------------------------

// loadForEdit comes from useComposerDraft (it lives next to the text state).
function focus(): void {
  // preventScroll keeps the pane from jumping if the composer is already in view
  // or if focus is triggered during an animation/transition.
  editor?.focus({ preventScroll: true });
}

/** Insert a quote pill at the document end (selection quote actions — 划词);
    the 评论 flow's comment rides in the same paragraph after the pill (see
    composerEditor's insertQuote). */
function insertQuote(quote: string, comment?: string): void {
  editor?.insertQuote({ text: quote }, comment);
}

function loadAttachmentsForEdit(atts: TurnAttachment[]): void {
  const fileSources = atts.filter((att) => att.kind === 'file' && att.fileId !== undefined);
  const seedEntries = seedEntriesForTurnAttachments(atts);
  // Media refills the chip strip; BOTH families are re-stamped from the
  // message's own appearance order (restampRefillByOrderHint), so the
  // resent payload keeps the original media/file interleave instead of
  // collapsing to media-first.
  const mediaReady = restampRefillByOrderHint(
    atts.filter((att) => att.kind !== 'file'),
    seedEntries,
    fileSources,
  );
  loadAttachments(mediaReady);
  // Files are in-document pills now: the refilled text's attachment links
  // (rewritten to 1..N at submit) revive into pills, and the registry is
  // seeded from the message's file attachments — the fileId rides along, so
  // nothing re-uploads. The text watcher's setText rebuilds the editor state
  // (resetting the registry) on the next flush — seed AFTER it lands, and
  // only entries the revived doc actually references.
  void nextTick(() => {
    const ed = editor;
    if (!ed) return;
    const referenced = new Set(ed.getOrderedAttachmentIds());
    for (const entry of seedEntries) {
      if (referenced.has(entry.attId)) ed.upsertAttachmentEntry(entry);
    }
    // LEGACY (see the note on AttachmentUploadDeps.adoptFileAttachment): a
    // chip-era message (pre-pill) carries no attachment links, so its file
    // attachments reference nothing in the revived doc — adopt them as
    // in-document pills (fileId reused, no re-upload) or edit&resending an
    // old message would silently drop its files. The adoption rides the seed
    // entry's restamped seq for that ordinal, so an adopted legacy file
    // keeps its original position in the media/file interleave instead of
    // landing after every media chip.
    for (const { att, ordinal } of unreferencedSeedFiles(atts, referenced)) {
      // Insert at the file's ORIGINAL ordinal, not blindly at the end: the
      // submit payload follows doc pill order, so appending an unreferenced
      // file behind the revived pills would reorder the resend (A,B → B,A).
      // The revived links carry their 1..N ordinals as attIds — the first
      // one past this ordinal is the anchor to insert before. A freshly
      // adopted pill gets a base36 attId, so it never anchors a later
      // insert (Number() → NaN) and the walk stays ordinal-anchored.
      const anchor = parseAttachmentLinks(ed.getText()).find((link) => {
        const attIndex = Number(link.attrs.attId);
        return Number.isInteger(attIndex) && attIndex > ordinal;
      });
      adoptFileAttachment(att, seedEntries.find((entry) => entry.attId === String(ordinal))?.seq, anchor?.start);
    }
  });
}

/** Re-seed the registry from a command emit's restoreEntries (the
 *  gate-failure restore of a skill command): the restored text carries the
 *  PRE-REWRITE draft whose links are attId-form, so the payload's ordinal
 *  seeding (loadAttachmentsForEdit) can't revive them — the ORIGINAL
 *  attId-keyed entries can, folder paths included. Same timing rule as the
 *  seed flow: upsert after the text watcher's rebuild lands, and only what
 *  the revived doc actually references. */
function restoreDraftEntries(entries: AttachmentEntry[]): void {
  void nextTick(() => {
    const ed = editor;
    if (!ed) return;
    const referenced = new Set(ed.getOrderedAttachmentIds());
    for (const entry of entries) {
      if (referenced.has(entry.attId)) ed.upsertAttachmentEntry(entry);
    }
  });
}

// defineExpose lives below the toolbar dropdown refs (see anyPopupOpen).

// Chip primary action: media opens the lightbox preview. MediaThumb passes
// its <img> along as the image preview's zoom origin.
const previewThumbImg = ref<HTMLImageElement | null>(null);

function onAttachmentActivate(att: Attachment, img?: HTMLImageElement | null): void {
  previewThumbImg.value = img ?? null;
  openAttachmentPreview(att);
}

// The pending-attachment preview maps onto the shared MediaLightbox — the
// same modal the sent-message chips open. Local object URLs play directly;
// anything else (edit/queue reloads) needs fileId for the authed fetch.
const previewMedia = computed<ToolMedia | null>(() => {
  const att = previewAttachment.value;
  if (!att || !att.previewUrl) return null;
  return {
    kind: att.kind === 'video' ? 'video' : 'image',
    url: att.previewUrl,
    path: att.name,
    fileId: att.previewUrl.startsWith('blob:') ? undefined : att.fileId,
    sessionId: att.previewUrl.startsWith('blob:') ? undefined : att.sessionId,
  };
});

/** The send gate's pill verdict (uploading / errored / missing) — see
 *  pillSubmitBlockers: an errored entry blocks like an in-flight upload,
 *  because the submit payload would silently drop it and its pill would
 *  degrade to a bare name, sending a message that's missing its attachment
 *  without any sign. A MISSING entry (an undo-resurrected pill whose
 *  registry entry the delete's reconcile dropped for good) blocks the same
 *  way. The pill shows the state (.attachment-error / .attachment-missing,
 *  the tooltip names the reason); the user deletes the pill or re-drops
 *  the file to retry (planFileAttachment restarts a dead upload on key
 *  reuse). */
const pillGate = computed(() => {
  // text.value is the reactive trigger for the doc side: an undo-resurrected
  // pill changes the doc WITHOUT touching the registry (the entry is gone
  // for good — the reconcile never invents it, so no onRegistryChange
  // fires), and only a text-driven recompute catches the dead pill.
  void text.value;
  return pillSubmitBlockers(attachmentEntries.value, editor?.getOrderedAttachmentIds() ?? []);
});

/** The submit-time attachment assembly shared by handleSubmit/handleSteer:
 *  ready media chips plus the doc's ready file pills, interleaved by the
 *  shared add-order stamp (interleaveSubmitAttachments) so the payload
 *  reflects the user's real add order across the two families. The payload's
 *  FILE entries keep their doc first-mention order among themselves — the
 *  text's rewritten 1..N link indices count only files and line up with
 *  those positions (and the server's trailing attachments notice). */
function submitAssembly(): { promptAttachments: PromptAttachment[]; rewriteAttIds: string[] } {
  const mediaReady = attachments.value.filter((a) => !a.uploading && !a.error && a.fileId);
  const fileSubmit = buildFileSubmitPayload(editor?.getOrderedAttachmentIds() ?? [], attachmentEntries.value);
  const seqByAttId = new Map(attachmentEntries.value.map((entry) => [entry.attId, entry.seq] as const));
  return {
    promptAttachments: interleaveSubmitAttachments(
      fileSubmit.promptAttachments.map((item, index) => ({ item, seq: seqByAttId.get(fileSubmit.rewriteAttIds[index]!) })),
      mediaReady.map((chip) => ({ item: toPromptAttachment(chip), seq: chip.seq })),
    ),
    rewriteAttIds: fileSubmit.rewriteAttIds,
  };
}

/** Rewrite the ATTACHMENT links of a submit-bound text copy: file pills →
 *  1..N index links (payload order), folder pills → real-path mention links.
 *  The composer doc and the persisted draft keep the attId form; links
 *  without a ready entry degrade to bare names inside the rewrite. QUOTE
 *  pills keep their link form here — the quote rewrite is applied only to
 *  daemon-bound texts (decideComposerSubmit's branches, handleSteer's
 *  payload), so history recall and gate-failure restores revive the pill. */
function rewriteForSubmit(trimmed: string, rewriteAttIds: readonly string[]): string {
  return rewriteAttachmentLinksForSubmit(trimmed, rewriteAttIds, {
    resolveFolder: (attId) => attachmentEntries.value.find((e) => e.attId === attId)?.path,
  });
}

/** Snapshot the doc's attachment pills for re-seeding after the text clear
 *  of a flow that consumes the text but NOT the attachments (built-in slash
 *  commands — see handleSubmit): the pills live IN the text now, so clearing
 *  it would silently destroy attachments the chip era kept pending. Returns
 *  the restore function — invoke it AFTER `text.value = ''`. The ordering is
 *  load-bearing: Vue's scheduler runs jobs by id, so a nextTick registered
 *  BEFORE the assignment would fire before the text watcher's setText('') and
 *  the restored pills would be wiped by it; registering after the assignment
 *  puts the watcher's rebuild first. The re-insert then lands on the fresh
 *  empty doc (registry already reset), pill BEFORE entry per the doc-reconcile
 *  invariant. Entry-less (dead) pills are skipped. */
function preserveAttachmentPills(): () => void {
  const ed = editor;
  if (!ed) return () => {};
  const byAttId = new Map(attachmentEntries.value.map((entry) => [entry.attId, entry] as const));
  // Snapshot the FULL attId sequence in document order (duplicates kept):
  // several pills can share one attId (the same file dropped twice, or a
  // pill copied in the composer), and an interleaved pair (A, B, A) must
  // come back in that exact order — grouping by id would restore A, A, B.
  // Only the registry upserts dedupe.
  const sequence = parseAttachmentLinks(ed.getText()).map((match) => match.attrs.attId);
  if (sequence.length === 0) return () => {};
  return () => {
    void nextTick(() => {
      const target = editor;
      if (!target) return;
      const upserted = new Set<string>();
      for (const attId of sequence) {
        const entry = byAttId.get(attId);
        if (entry === undefined) continue;
        target.insertAttachment({ attId: entry.attId, name: entry.name, kind: entry.kind });
        if (!upserted.has(attId)) {
          target.upsertAttachmentEntry(entry);
          upserted.add(attId);
        }
      }
    });
  };
}

/** The /new and /clear case of the built-in command branch: the App leaves
 *  this session on emit (workspace draft / cleared session) and this
 *  composer unmounts in the SAME flush — preserveAttachmentPills' nextTick
 *  restore would run against a null editor, and the unmount stash would
 *  write the wiped registry back over everything. Persist the kept pills
 *  SYNCHRONOUSLY instead: the sidecar gets the entries now, and the draft
 *  text is re-assigned to the pills' link forms — the earlier clear and
 *  this assignment collapse into ONE watcher flush, so the text watcher's
 *  same-session rebuild lands the links on the INTACT registry (the clear
 *  never lands as its own rebuild) and re-persists it, and the unmount
 *  stash (text already matches) stores the healthy state. A later restore
 *  revives the pills like any other draft. */
function persistPillsForDeparture(): void {
  const ed = editor;
  if (!ed) return;
  const byAttId = new Map(attachmentEntries.value.map((entry) => [entry.attId, entry] as const));
  // The FULL attId sequence in document order (duplicates kept) — several
  // pills can share one attId (the same file dropped twice, or a copied
  // pill), and an interleaved pair (A, B, A) must persist in that exact
  // order: grouping by id would drop both the extra references AND their
  // position. The sidecar entries dedupe; the link text doesn't.
  const sequence = parseAttachmentLinks(ed.getText()).map((match) => match.attrs.attId);
  const kept: AttachmentEntry[] = [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const attId of sequence) {
    const entry = byAttId.get(attId);
    if (entry === undefined) continue;
    if (!seen.has(attId)) {
      kept.push(entry);
      seen.add(attId);
    }
    links.push(serializeAttachment({ attId: entry.attId, name: entry.name, kind: entry.kind }));
  }
  if (links.length === 0) return;
  saveDraftAttachments(props.sessionId, kept);
  text.value = links.join(' ');
}

/** The submit decision for the CURRENT draft — the single source for both
 *  the send button's disabled state and handleSubmit's executor, so the two
 *  can never disagree (the button must allow exactly what handleSubmit
 *  would run, including a non-consuming command under a closed gate). The
 *  assembly is a pure read, so computing it unconditionally (even when the
 *  gate blocks) changes nothing. */
function currentSubmitDecision(): SubmitDecision {
  const trimmed = text.value.trim();
  const assembly = submitAssembly();
  return decideComposerSubmit({
    text: trimmed,
    rewritten: rewriteForSubmit(trimmed, assembly.rewriteAttIds),
    blocked:
      attachments.value.some((a) => a.uploading) ||
      pillGate.value.uploading ||
      pillGate.value.errored ||
      pillGate.value.missing,
    assembly,
    skillMentions: editor?.getSkillMentions() ?? [],
    skills: props.skills,
    skillsLoaded: props.skillsLoaded,
    working: props.working,
    running: props.running,
    queueLength: props.queued.length,
    goalMode: props.goalMode,
  });
}

/** True when a submit would do something — the button's disabled state IS
 *  the decision's noop verdict (an empty draft or a closed gate on an
 *  attachment-carrying branch). */
const canSend = computed(() => currentSubmitDecision().kind !== 'noop');

function handleSubmit(): void {
  // Every branch DECISION (the send gate, the work-mode match, the slash
  // resolution order, the skill-pill activation vetoes, per-branch
  // cmd/attachments/history semantics) lives in the pure, unit-tested
  // decideComposerSubmit — this function is only its executor: ref mutations,
  // editor calls, emits.
  const decision = currentSubmitDecision();
  if (decision.kind === 'noop') return;
  if (decision.kind === 'invalid-command') {
    // A no-arg command with junk after it — refuse LOCALLY (the command is
    // NOT a skill, so falling through to the app's skill-activation default
    // would send it to the daemon for a pointless skill.not_found). The
    // draft — text AND pills — stays untouched; no history entry either.
    client.notify({ severity: 'warning', title: t('composer.noArgCommand', { cmd: decision.cmd }) });
    return;
  }
  // ↑/↓ recall — recorded for commands AND plain messages alike (the push
  // ignores empty/whitespace, so an attachment-only send adds nothing). The
  // decision carries the stripped text: a recalled entry must not revive dead
  // pills out of the submit-time 1..N index links.
  history.push(decision.historyText);
  // A send abandons any pre-browse draft — drop its entry snapshot with it
  // (push already reset the browse cursor).
  historyEntrySnapshot = null;

  switch (decision.kind) {
    case 'mode': {
      // A bare work-mode command is consumed locally — the doc's pills stay
      // pending for the next message, re-seeded after the text clear.
      const restorePills = preserveAttachmentPills();
      text.value = '';
      clearDraft();
      slashOpen.value = false;
      collapseAndRefit();
      if (decision.mode === 'plan') armPlanMode();
      else if (decision.mode === 'goal') armGoalMode();
      // `/swarm`: enable-only consumption — the chip's × is the off switch,
      // so a click-send must not toggle the mode off (the App's bare-/swarm
      // handler would).
      else if (!swarmOn.value) emit('toggleSwarm');
      restorePills();
      return;
    }

    case 'skill-activation':
    case 'skill-command':
    case 'unresolved-skill-command': {
      text.value = '';
      clearDraft();
      clearDraftAttachments();
      slashOpen.value = false;
      collapseAndRefit();
      // The attachments leave with the command — mirror the plain-submit
      // cleanup so they don't linger (and their object URLs are revoked).
      previewAttachment.value = null;
      previewThumbImg.value = null;
      clearAfterSubmit();
      closeMentionMenu();
      if (decision.kind === 'skill-activation') {
        emit('command', { cmd: decision.cmd, attachments: decision.attachments, restoreText: decision.restoreText, skillName: decision.skillName, restoreEntries: attachmentEntries.value });
      } else if (decision.kind === 'skill-command') {
        emit('command', { cmd: decision.cmd, attachments: decision.attachments, restoreText: decision.restoreText, skillName: decision.skillName, restoreEntries: attachmentEntries.value });
      } else {
        emit('command', { cmd: decision.cmd, attachments: decision.attachments, restoreText: decision.restoreText, restoreEntries: attachmentEntries.value });
      }
      return;
    }

    case 'builtin-command': {
      // No attachment payload — the doc's pills survive the text clear
      // (restorePills is invoked AFTER the clear, landing on the fresh doc).
      text.value = '';
      clearDraft();
      slashOpen.value = false;
      collapseAndRefit();
      if (decision.leave) {
        // The App leaves this session on /new and /clear and unmounts this
        // composer in the same flush — persist the kept pills synchronously
        // instead of the nextTick restore (see persistPillsForDeparture).
        persistPillsForDeparture();
        emit('command', { cmd: decision.cmd, attachments: [], restoreText: decision.restoreText, restoreEntries: attachmentEntries.value });
        return;
      }
      const restorePills = preserveAttachmentPills();
      restorePills();
      emit('command', { cmd: decision.cmd, attachments: [], restoreText: decision.restoreText, restoreEntries: attachmentEntries.value, editText: decision.editText });
      return;
    }

    case 'submit': {
      // Revoke object URLs and drop the submitted attachments.
      previewAttachment.value = null;
      previewThumbImg.value = null;
      clearAfterSubmit();
      text.value = '';
      clearDraft();
      clearDraftAttachments();
      slashOpen.value = false;
      closeMentionMenu();
      collapseAndRefit();
      emit('submit', { text: decision.text, restoreText: decision.restoreText, editText: decision.editText, attachments: decision.attachments, restoreEntries: attachmentEntries.value });
      return;
    }
  }
}

/**
 * Steer (TUI ctrl+s): push the current text — and the parent merges any queued
 * prompts — straight into the running turn. With an empty composer it still
 * fires when something is queued, so "queue a few thoughts, then ctrl+s" works.
 */
function handleSteer(): void {
  if (!props.running) return;
  // Same gate as handleSubmit: an in-flight upload would be sent without its
  // file; an errored or missing pill would be silently dropped from the payload.
  if (attachments.value.some((a) => a.uploading) || pillGate.value.uploading || pillGate.value.errored || pillGate.value.missing) return;

  const trimmed = text.value.trim();
  const assembly = submitAssembly();
  if (!trimmed && assembly.promptAttachments.length === 0 && props.queued.length === 0) return;

  // Steer is daemon-bound: quote pills serialize to their `> ` blocks here
  // (same decision-level rewrite as handleSubmit's branches).
  const payload = {
    text: rewriteQuoteLinks(rewriteForSubmit(trimmed, assembly.rewriteAttIds)).trim(),
    attachments: assembly.promptAttachments,
  };
  clearAfterSubmit();
  // Same strip as handleSubmit: history recall must not revive dead pills —
  // and a pill-ONLY steer records nothing (a bare name is not a draft — its
  // recall would come back registry-less and resend just the filename). The
  // entry derives from the PRE-REWRITE draft: quote links survive and revive
  // on recall (the daemon-bound payload's flattened blocks would not).
  history.push(steerHistoryText(trimmed));
  // Same abandonment as handleSubmit: the pre-browse draft's snapshot dies
  // with the send.
  historyEntrySnapshot = null;
  text.value = '';
  clearDraft();
  clearDraftAttachments();
  slashOpen.value = false;
  closeMentionMenu();
  collapseAndRefit();
  emit('steer', payload);
}

let isComposingText = false;
let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

function clearCompositionEndTimer(): void {
  if (compositionEndTimer !== null) {
    clearTimeout(compositionEndTimer);
    compositionEndTimer = null;
  }
}

function handleCompositionStart(): void {
  clearCompositionEndTimer();
  isComposingText = true;
}

function handleCompositionEnd(): void {
  clearCompositionEndTimer();
  compositionEndTimer = setTimeout(() => {
    compositionEndTimer = null;
    isComposingText = false;
  }, 0);
}

function isComposingKeyEvent(e: KeyboardEvent): boolean {
  return isComposingText || e.isComposing || e.keyCode === 229;
}

// Keydown arbitrator, wired as the PM editor's handleKeyDown prop. Return
// true = claimed (we preventDefault those ourselves, which also keeps them
// from the global shortcut dispatcher); false = fall through to the PM
// keymaps (history undo/redo, baseKeymap's Enter/Backspace behavior) and the
// browser default.
function handleKeydown(e: KeyboardEvent): boolean {
  if (isComposingKeyEvent(e)) return false;

  // Backspace at the very start of the text deletes the mode pill (chip-style
  // dismissal), rather than doing nothing.
  if (workMode.value && e.key === 'Backspace' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const sel = editorRef.value;
    if (sel?.selectionStart === 0 && sel.selectionEnd === 0) {
      e.preventDefault();
      clearWorkMode();
      return true;
    }
  }

  // Close dropdowns on Escape
  if (e.key === 'Escape') {
    if (addMenuOpen.value) {
      e.preventDefault();
      closeAddMenu();
      return true;
    }
    if (dropdownOpen.value) {
      e.preventDefault();
      closeDropdown();
      return true;
    }
    if (permDropdownOpen.value) {
      e.preventDefault();
      closePermDropdown();
      return true;
    }
  }

  // Slash menu navigation. Escape closes even the empty ("no commands") menu —
  // arrows/Enter/Tab only apply with items; an empty menu lets Enter fall
  // through to the normal submit.
  if (slashOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      slashOpen.value = false;
      return true;
    }
    // An empty ("no commands") menu has nothing to select — let Tab move
    // focus on, but close the menu so it can't strand the popup open.
    if (e.key === 'Tab' && slashItems.value.length === 0) {
      slashOpen.value = false;
      return false;
    }
  }
  if (slashOpen.value && slashItems.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashActive.value = (slashActive.value + 1) % slashItems.value.length;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashActive.value = (slashActive.value - 1 + slashItems.value.length) % slashItems.value.length;
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const item = slashItems.value[slashActive.value];
      if (item) selectSlashCommand(item);
      return true;
    }
  }

  // Mention menu navigation. Escape closes whenever the menu is open — even
  // mid-search; the rows stay visible and clickable while a search loads, so
  // arrows/Enter/Tab keep working too, gated only on there being any items.
  // With no items (the bare-@ hint or no-match state) Enter/Tab/arrows keep
  // their normal composer behavior so the menu never blocks sending.
  if (mentionOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionMenu();
      return true;
    }
    if (mentionItems.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionNavigate((mentionActive.value + 1) % mentionItems.value.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionNavigate((mentionActive.value - 1 + mentionItems.value.length) % mentionItems.value.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = mentionItems.value[mentionActive.value];
        if (item) selectMentionItem(item);
        return true;
      }
    }
  }

  // Ctrl+S / Cmd+S — steer into the running turn (TUI parity). Hardcoded by
  // decision (not customizable). The chord is consumed even when idle so it
  // can't leak to the global dispatcher or the send/newline handling below.
  if (e.key === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (props.running) {
      handleSteer();
    }
    return true;
  }

  // History recall (shell-style ↑/↓) — see useInputHistory for the machinery.
  //
  // Disabled entirely in the expanded editor: that mode is for composing long
  // multi-line text, so the arrows always move the caret within the draft and
  // never jump to a previous message.
  //
  // ENTERING history: a plain ArrowUp recalls only when the draft is
  // COMPLETELY empty — with any content (whitespace included) the arrows
  // always move the caret, never hijack it into a previous message. ONCE
  // BROWSING, the arrows walk history directly even though the recalled text
  // now fills the composer — the browsing cursor (useInputHistory's
  // historyIndex), not emptiness, carries the walk. Typing exits history
  // (handleInput resets browsing), after which the arrows are the caret's
  // again, so an edited recalled entry can no longer be pushed away.
  // An empty-result slash menu is only the status note — it must not
  // block history recall.
  const slashMenuBlocking = slashOpen.value && slashItems.value.length > 0;
  if (!expanded.value && !slashMenuBlocking && !mentionOpen.value && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const browsing = history.isBrowsing();
    if (e.key === 'ArrowUp' && history.canRecallOlder()) {
      e.preventDefault();
      if (!browsing) {
        // Entering history: snapshot the draft's attachment entries (entry
        // objects are never mutated in place — a per-entry spread is a true
        // snapshot). The recall rebuilds (the text watcher's same-session
        // setText) drop them via the init reconcile — history text carries
        // no attachment links — and the sidecar follows, so without the
        // snapshot the draft's pills come back dead on the walk home.
        historyEntrySnapshot = attachmentEntries.value.map((entry) => ({ ...entry }));
      }
      history.recallOlder();
      // Recall rewrites `text` directly, bypassing handleInput. Close the
      // slash menu outright rather than recompute it — recomputing would
      // reopen a populated menu when the recalled entry is a bare command
      // ('/new'), and the menu's arrow-key branch would then swallow the
      // next history step. Typing reopens the menu via handleInput.
      slashOpen.value = false;
      return true;
    }
    if (e.key === 'ArrowDown' && browsing) {
      e.preventDefault();
      history.recallNewer();
      slashOpen.value = false;
      if (!history.isBrowsing()) {
        // Back at the live draft: its text (with attachment links) returns
        // via the text watcher's setText — but the history walk's rebuilds
        // dropped the registry entries those links point at (and persisted
        // the wipe to the sidecar). Re-seed the browse-start snapshot once
        // the rebuild has landed, filtered to what the restored doc
        // actually references.
        const snapshot = historyEntrySnapshot;
        historyEntrySnapshot = null;
        if (snapshot !== null && snapshot.length > 0) {
          void nextTick(() => {
            const ed = editor;
            if (!ed) return;
            const referenced = new Set(ed.getOrderedAttachmentIds());
            for (const entry of snapshot) {
              if (referenced.has(entry.attId)) ed.upsertAttachmentEntry(entry);
            }
          });
        }
      }
      return true;
    }
  }

  // Send / newline — customizable bindings (defaults: Enter sends, Shift+Enter
  // inserts a newline). Default and rebound combos alike go through the
  // editor's splitBlock so the insert lands in the PM undo history
  // (baseKeymap binds only Enter — Shift+Enter must be handled here, the
  // browser's native contenteditable newline would produce DOM PM can't map
  // to the schema). The preventDefault also keeps the chord away from the
  // global shortcut dispatcher (it skips defaultPrevented events).
  const newlineBinding = resolvedBinding('composer.newline');
  if (newlineBinding !== null && matchBinding(e, newlineBinding)) {
    e.preventDefault();
    insertNewlineAtCaret();
    return true;
  }
  const sendBinding = resolvedBinding('composer.send');
  // Default send ('enter') keeps the legacy aliases in BOTH modes: plain
  // Enter sends in the collapsed composer, and mod+Enter / Ctrl+Enter send
  // in either mode (all were the pre-customization chords). The expanded
  // editor only drops plain Enter — it inserts newlines there. A custom
  // send binding wins in both modes and matches exactly.
  const sendMatches =
    sendBinding !== null &&
    (sendBinding === 'enter'
      ? matchBinding(e, 'mod+enter') || matchBinding(e, 'ctrl+enter') || (!expanded.value && matchBinding(e, 'enter'))
      : matchBinding(e, sendBinding));
  if (sendMatches) {
    e.preventDefault();
    handleSubmit();
    return true;
  }
  // The default newline combo was rebound away (or unassigned): swallow its
  // old behavior so the old key stops inserting newlines behind the
  // user's back. Runs AFTER the send match so a send rebound to Shift+Enter
  // still wins the chord.
  if (newlineBinding !== 'shift+enter' && matchBinding(e, 'shift+enter')) {
    e.preventDefault();
    return true;
  }
  return false;
}

// Insert a line break at the caret programmatically: a rebound newline combo
// (say Ctrl+Enter) has no keymap default, so the composer has to do it itself.
// The editor's splitBlock is a normal transaction, so it IS undoable via PM
// history, and onChange runs handleInput for us.
function insertNewlineAtCaret(): void {
  if (!editor) {
    text.value += '\n';
    handleInput();
    return;
  }
  editor.insertNewlineAtCaret();
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

// Send is always "send" — while running it enqueues (handled upstream by
// sendPrompt). Interrupt lives on a separate Stop button so the two can never
// be confused.
const sendLabel = computed(() => t('composer.send'));
const hasUpload = computed(() => !!props.uploadImage);

// ---------------------------------------------------------------------------
// Bottom toolbar — split into individual controls
// ---------------------------------------------------------------------------

const dropdownOpen = ref(false);
const permDropdownOpen = ref(false);
const addMenuOpen = ref(false);
const toolbarRef = ref<HTMLElement | null>(null);
const addMenuRef = ref<HTMLElement | null>(null);
const permPillRef = ref<HTMLElement | null>(null);
const permDropdownRef = ref<HTMLElement | null>(null);
const modelPillRef = ref<HTMLElement | null>(null);

// The add / permission / model popups are bespoke menu surfaces (not the Menu
// primitive): while one is open, tooltips outside it hide (native behavior).
trackMenuSurface(addMenuOpen, addMenuRef);
trackMenuSurface(permDropdownOpen, permDropdownRef);

// Add-menu overlay scroll thumb (same vocabulary as the slash/mention
// menus): the native bar is hidden so rows keep their full width.
const addScrollRef = ref<HTMLElement | null>(null);
const addThumb = ref<{ top: number; height: number } | null>(null);
let addScrollObserver: ResizeObserver | null = null;

function updateAddScrollState(): void {
  const el = addScrollRef.value;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight + 1) {
    addThumb.value = null;
    return;
  }
  const menuStyle = getComputedStyle(el);
  const inset =
    parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-track-inset')) || 0;
  const minThumb =
    parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-thumb-min')) || 24;
  const track = clientHeight - inset * 2;
  const height = Math.max(minThumb, (clientHeight / scrollHeight) * track);
  const maxScroll = scrollHeight - clientHeight;
  const top = el.offsetTop + inset + (scrollTop / maxScroll) * (track - height);
  addThumb.value = { top, height };
}

function onAddMenuScroll(): void {
  updateAddScrollState();
}

watch(addMenuOpen, async (open) => {
  addScrollObserver?.disconnect();
  addScrollObserver = null;
  addThumb.value = null;
  if (!open) return;
  await nextTick();
  updateAddScrollState();
  if (typeof ResizeObserver === 'function' && addScrollRef.value) {
    addScrollObserver = new ResizeObserver(updateAddScrollState);
    addScrollObserver.observe(addScrollRef.value);
  }
});
onUnmounted(() => {
  addScrollObserver?.disconnect();
  addScrollObserver = null;
});
const modelMenuRight = ref('');
const modelMenuMaxHeight = ref('');
const modelMenuDropDown = ref(false);
const modelMenuStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {};
  if (modelMenuRight.value) style.right = modelMenuRight.value;
  if (modelMenuMaxHeight.value) style.maxHeight = modelMenuMaxHeight.value;
  return style;
});

// Any transient popup above the composer (model / permission dropdown, slash
// or mention menu). ConversationPane reads this to keep its Esc-to-interrupt
// quiet while a popup owns Escape — e.g. a dropdown opened from the toolbar,
// where focus is outside the textarea and its Esc never reaches handleKeydown.
const anyPopupOpen = computed(
  () => dropdownOpen.value || permDropdownOpen.value || addMenuOpen.value || slashOpen.value || mentionOpen.value,
);

const isEmpty = () => text.value.trim().length === 0 && attachments.value.length === 0 && attachmentEntries.value.length === 0;

defineExpose({ loadForEdit, insertQuote, loadAttachmentsForEdit, restoreDraftEntries, focus, anyPopupOpen, isEmpty });

function toggleDropdown(): void {
  dropdownOpen.value = !dropdownOpen.value;
  if (dropdownOpen.value) {
    updateModelMenuPosition();
    permDropdownOpen.value = false;
    addMenuOpen.value = false;
    document.addEventListener('click', onDocClick, true);
  } else {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closeDropdown(): void {
  dropdownOpen.value = false;
  if (!permDropdownOpen.value && !addMenuOpen.value) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function togglePermDropdown(): void {
  permDropdownOpen.value = !permDropdownOpen.value;
  if (permDropdownOpen.value) {
    updatePermissionMenuPosition();
    dropdownOpen.value = false;
    addMenuOpen.value = false;
    document.addEventListener('click', onDocClick, true);
  } else {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closePermDropdown(): void {
  permDropdownOpen.value = false;
  if (!dropdownOpen.value && !addMenuOpen.value) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function toggleAddMenu(): void {
  addMenuOpen.value = !addMenuOpen.value;
  if (addMenuOpen.value) {
    dropdownOpen.value = false;
    permDropdownOpen.value = false;
    // Popups are exclusive in both directions — an open slash/mention list
    // would overlap the add menu at the same spot with stale aria-controls.
    // close() (not a bare open=false) so a pending mention search can't
    // reopen its menu over the add menu.
    slashOpen.value = false;
    closeMentionMenu();
    document.addEventListener('click', onDocClick, true);
    // A real menu takes DOM focus on open (the textarea's combobox ARIA never
    // points at it); Escape and selection hand focus back to the textarea.
    void nextTick(() => {
      addMenuRef.value?.querySelector<HTMLElement>('.am-row')?.focus();
    });
  } else {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closeAddMenu(): void {
  addMenuOpen.value = false;
  if (!dropdownOpen.value && !permDropdownOpen.value) {
    document.removeEventListener('click', onDocClick, true);
  }
}

// Add-menu items — files first (upload-capable only), then the work modes,
// then the swarm toggle (enable-only here; its off switch is the chip's ×).
const addItems = computed(() => {
  const items: { id: string; icon: IconName; nameKey: string; descKey?: string; action: () => void }[] = [];
  if (hasUpload.value) {
    items.push({ id: 'files', icon: 'attachment', nameKey: 'composer.addFiles', action: onAddFiles });
  }
  items.push({ id: 'goal', icon: 'target', nameKey: 'status.goalLabel', descKey: 'composer.addGoalDesc', action: onAddGoalMode });
  items.push({ id: 'plan', icon: 'file-edit', nameKey: 'status.planLabel', descKey: 'composer.addPlanDesc', action: onAddPlanMode });
  items.push({ id: 'swarm', icon: 'sparkles', nameKey: 'status.swarmLabel', descKey: 'composer.addSwarmDesc', action: onAddSwarmMode });
  return items;
});

function selectAddItem(item: { action: () => void }): void {
  item.action(); // every action closes the menu
  focus();
}

// Menu-pattern keys on the menu surface: arrows move DOM focus between rows,
// Escape closes and returns to the textarea, Tab closes and lets focus move.
function onAddMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAddMenu();
    focus();
    return;
  }
  if (e.key === 'Tab') {
    closeAddMenu();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = Array.from(addMenuRef.value?.querySelectorAll<HTMLElement>('.am-row') ?? []);
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

function onAddFiles(): void {
  closeAddMenu();
  openFilePicker();
}

function onAddGoalMode(): void {
  closeAddMenu();
  // Enable-only — the armed pill's × is the off switch. (A live goal still
  // focuses its panel via armGoalMode.)
  if (!props.goalMode) armGoalMode();
}

function onAddPlanMode(): void {
  closeAddMenu();
  if (!planOn.value) armPlanMode();
}

function onAddSwarmMode(): void {
  closeAddMenu();
  // Enable-only: the off switch is the toolbar chip's hover ×.
  if (!swarmOn.value) emit('toggleSwarm');
}

function onDocClick(e: MouseEvent): void {
  // The add menu lives in .cin-wrap, not in the toolbar — and this capture
  // listener runs before the menu item's own click, so closing it here would
  // unmount the target button and swallow the selection entirely.
  const target = e.target as Node;
  const insideToolbar = toolbarRef.value?.contains(target) ?? false;
  const insideAddMenu = addMenuRef.value?.contains(target) ?? false;
  if (!insideToolbar && !insideAddMenu) {
    closeDropdown();
    closePermDropdown();
    closeAddMenu();
  }
}

onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true);
});

// Clamped to 0–100: ctxUsed can momentarily exceed ctxMax (estimates), and
// ctxMax can be 0 before the first status fetch — both broke the ring. ceil
// (not round) so a session under 0.5% usage still shows a sliver of arc —
// Math.round floored it to an empty, "no data"-looking ring.
const pct = computed(() => {
  const max = props.status?.ctxMax ?? 0;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil(((props.status?.ctxUsed ?? 0) / max) * 100)));
});

const ctxTooltip = computed(() => {
  const used = formatTokens(props.status?.ctxUsed ?? 0);
  const max = formatTokens(props.status?.ctxMax ?? 0);
  return t('status.ctxTooltip', { used, max, pct: pct.value });
});

const showCompact = computed(() => pct.value >= 80);

// Thinking toggle
// Identity is the model id — display/model names can collide across providers.
const currentModel = computed(() =>
  props.models?.find((m) => m.id === props.status?.modelId),
);
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingSegments = computed(() => segmentsFor(currentModel.value));
// The client resolves the level per model (the model's stored pick when still
// declared, else the catalog default), so what arrives here is valid for the
// active model and highlights its segment. An undeclared level can only appear
// transiently, before the catalog loads, and simply highlights no segment.
const thinkingLevel = computed(() => effectiveThinkingLevel(currentModel.value, props.thinking));
const activeThinkingSegment = computed(() => {
  const segs = thinkingSegments.value;
  return segs.includes(thinkingLevel.value) ? thinkingLevel.value : '';
});
const thinkingOn = computed(() => isThinkingOn(thinkingLevel.value));
// Single-segment (always-on boolean) or unsupported models can't be changed.
const thinkingReadonly = computed(
  () => thinkingAvailability.value === 'unsupported' || thinkingSegments.value.length <= 1,
);
// Footer-style suffix: effort models show the concrete level; boolean models
// keep the plain "thinking" tag; off shows nothing.
const thinkingSuffix = computed(() => {
  if (!thinkingOn.value) return '';
  const hasEfforts = (currentModel.value?.supportEfforts?.length ?? 0) > 0;
  const level = thinkingLevel.value;
  if (hasEfforts && level !== 'on') return t('composer.thinkingSuffixEffort', { level });
  return t('composer.thinkingSuffix');
});
function setThinkingSegment(draft: string): void {
  if (thinkingReadonly.value) return;
  emit('setThinking', commitLevel(currentModel.value, draft));
}
function thinkingSegmentLabel(segment: string): string {
  if (segment === 'on') return t('status.thinkingOn');
  if (segment === 'off') return t('status.thinkingOff');
  return effortLabel(segment);
}
// Options for the shared SegmentedControl (same control as settings/mobile).
const thinkingOptions = computed(() =>
  thinkingSegments.value.map((seg) => ({ value: seg, label: thinkingSegmentLabel(seg) })),
);

// Plan toggle — lit for the intent (armed) and the daemon fact alike.
const planOn = computed(() => props.planArmed === true || props.planMode === true);
const swarmOn = computed(() => props.swarmMode === true);
const goalStatus = computed(() => props.goal?.status ?? props.activationBadges?.goal?.status ?? null);
const goalActive = computed(() => goalStatus.value !== null && goalStatus.value !== 'complete');

// The primary work mode is exclusive: the goal ARMED flag or plan ARMED
// intent, shown as a single leading pill inside the input row — a directive
// ("the next send enters this mode"), never a status. An active goal or an
// active plan (daemon facts) live on the dock workbar instead, so this pill
// hides once the intent is cashed. Swarm is an orthogonal agent-usage toggle
// with its own toolbar chip.
const workMode = computed<'plan' | 'goal' | null>(() =>
  props.goalMode ? 'goal' : props.planArmed ? 'plan' : null,
);
function clearWorkMode(): void {
  if (workMode.value === 'goal') emit('toggleGoal');
  else if (workMode.value === 'plan') emit('togglePlan');
}

// Permission modes
const PERM_MODES: { mode: PermissionMode; icon: IconName; color: string; labelKey: string; descKey: string }[] = [
  { mode: 'manual', icon: 'hand', color: 'var(--color-text)', labelKey: 'status.permissionManual', descKey: 'status.permissionManualDesc' },
  { mode: 'yolo', icon: 'shield-question', color: 'var(--color-warning)', labelKey: 'status.permissionYolo', descKey: 'status.permissionYoloDesc' },
  { mode: 'auto', icon: 'full-access', color: 'var(--color-danger)', labelKey: 'status.permissionAuto', descKey: 'status.permissionAutoDesc' },
];

const menuMeasureRef = ref<HTMLElement | null>(null);
const permissionDescriptionWidth = ref('');
const permissionMenuLeft = ref('');
function menuDescStyle(width: string): Record<string, string> {
  const style: Record<string, string> = {};
  if (width) style['--composer-menu-desc-width'] = width;
  return style;
}
const permissionMenuStyle = computed<Record<string, string>>(() => ({
  ...menuDescStyle(permissionDescriptionWidth.value),
  ...(permissionMenuLeft.value ? { left: permissionMenuLeft.value } : {}),
}));

function updatePermissionMenuPosition(): void {
  const anchor = permPillRef.value;
  const toolbar = toolbarRef.value;
  if (!anchor || !toolbar) {
    permissionMenuLeft.value = '';
    return;
  }
  permissionMenuLeft.value = `${Math.round(anchor.getBoundingClientRect().left - toolbar.getBoundingClientRect().left)}px`;
}

function updateModelMenuPosition(): void {
  const anchor = modelPillRef.value;
  const toolbar = toolbarRef.value;
  if (!anchor || !toolbar) {
    modelMenuRight.value = '';
    return;
  }
  modelMenuRight.value = `${Math.round(toolbar.getBoundingClientRect().right - anchor.getBoundingClientRect().right)}px`;
}
let menuMeasureFrame: number | null = null;

function cssPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function canvasFont(style: CSSStyleDeclaration): string {
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize} ${style.fontFamily}`;
}

function letterSpacingPx(style: CSSStyleDeclaration): number {
  return style.letterSpacing === 'normal' ? 0 : cssPx(style.letterSpacing);
}

function measureTextWidth(text: string, style: CSSStyleDeclaration): number {
  if (!text) return 0;
  const prepared = prepareWithSegments(text, canvasFont(style), {
    letterSpacing: letterSpacingPx(style),
  });
  return measureNaturalWidth(prepared);
}

function measureMenuDescriptions(): void {
  const probe = menuMeasureRef.value?.querySelector<HTMLElement>('.pd-desc');
  if (!probe) return;
  const style = getComputedStyle(probe);
  const permissionWidth = Math.max(
    0,
    ...PERM_MODES.map((opt) => measureTextWidth(t(opt.descKey), style)),
  );
  permissionDescriptionWidth.value = permissionWidth > 0 ? `${Math.ceil(permissionWidth)}px` : '';
}

function scheduleMenuDescriptionMeasure(): void {
  if (typeof window === 'undefined') return;
  if (menuMeasureFrame !== null) {
    window.cancelAnimationFrame(menuMeasureFrame);
  }
  void nextTick(() => {
    menuMeasureFrame = window.requestAnimationFrame(() => {
      menuMeasureFrame = null;
      measureMenuDescriptions();
    });
  });
}

watch(
  locale,
  () => {
    scheduleMenuDescriptionMeasure();
    // Descriptions change language — re-filter an open slash menu so the
    // results (and their highlight ranges) match the new text.
    if (slashOpen.value) updateSlashMenu();
  },
  { immediate: true },
);

onMounted(() => {
  scheduleMenuDescriptionMeasure();
  void document.fonts?.ready.then(scheduleMenuDescriptionMeasure);
});

onUnmounted(() => {
  if (menuMeasureFrame !== null) {
    window.cancelAnimationFrame(menuMeasureFrame);
    menuMeasureFrame = null;
  }
});

function choosePermission(mode: PermissionMode): void {
  emit('setPermission', mode);
  closePermDropdown();
}

const permInfo = computed(() => PERM_MODES.find((p) => p.mode === props.status?.permission));
const permLabel = computed(() => (permInfo.value ? t(permInfo.value.labelKey) : ''));
const permIcon = computed<IconName>(() => permInfo.value?.icon ?? 'hand');

// ---------------------------------------------------------------------------
// Toolbar collapse — one valve, everything else rigid. The toolbar is a flex
// row where the model name is the ONLY yielding element: the left cluster
// (attach / permission / swarm) never crushes — under pressure its pills flip
// straight from full text to icon circles. A single computed verdict drives
// the first two stage changes: the valve (model name) measured crushed below
// the readability floor. Stage 0→1 flips the label pills to icons; the freed
// room lets the name recover on its own (pure CSS). If it still lands below
// the floor, stage 1→2 flips the model pill to its bare model icon. Once even
// the icon row cannot fit (phone-narrow with every optional control aboard),
// stage 2→3 drops the /compact chip — the one control that merely duplicates
// a slash command; with the valve element gone by then, that verdict is the
// right cluster physically overflowing its own box, and with no chip aboard
// the machine skips straight to stage 4. If it STILL overflows (a working
// turn adds Stop next to Send), stage 3→4 drops the model pill itself — a
// bare launcher by then, whose identity and picker both live in the
// settings sheet. The way back is hysteresis: a stage only re-opens once
// the row has grown past its collapse point plus the margin, so the boundary
// can never flap.
// ---------------------------------------------------------------------------
const toolbarLabelsCollapsed = ref(false);
const modelPillCollapsed = ref(false);
const compactChipGone = ref(false);
const modelPillGone = ref(false);
const mpNameRef = ref<HTMLElement | null>(null);
const toolbarRightRef = ref<HTMLElement | null>(null);
/* Thresholds live on the card as em-based CSS tokens (see .composer-card) so
   they track the UI font scale and stay out of the script. */
let labelsCollapsedAt = 0;
let modelCollapsedAt = 0;
let compactGoneAt = 0;
let modelGoneAt = 0;

function toolbarCollapseTokens(): { valveFloor: number; expandMargin: number } {
  const style = toolbarRef.value ? getComputedStyle(toolbarRef.value) : null;
  return {
    valveFloor: style ? lengthToken(style, '--composer-valve-floor', 56) : 56,
    expandMargin: style ? lengthToken(style, '--composer-valve-expand-margin', 48) : 48,
  };
}

/* The stage 3/4 verdict: the right cluster is justify-end, so when its rigid
   children no longer fit, its rendered content spills past the box's left
   edge. Probe the leaf controls directly — box-less wrappers (display:
   contents tooltips) and display:none children have no rect of their own. */
function rightClusterOverflows(right: HTMLElement): boolean {
  const boxLeft = right.getBoundingClientRect().left;
  for (const el of right.querySelectorAll('.compact-chip, .ctx-group, .model-pill, .stop, .send')) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.left < boxLeft - 1) return true;
  }
  return false;
}

/* Reads a CSS length token that may be written in em: getComputedStyle
   returns custom properties as the SPECIFIED token ("4em"), not a resolved
   length — resolve em against the element's own computed font size (the
   font-scale-aware size the tokens are meant to track). */
function lengthToken(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = style.getPropertyValue(name).trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('em') ? value * parseFloat(style.fontSize) : value;
}

/* Genuine-crush test for an overflow:hidden flex label: Chrome reports
   scrollWidth 0 once such an element lands at exactly 0 width (a one-frame
   squeeze can land there without passing through the readable range), so a
   zero-width element that still has text counts as fully crushed too. */
function textCrushed(el: HTMLElement): boolean {
  return (
    el.scrollWidth > el.clientWidth + 1 ||
    (el.clientWidth === 0 && (el.textContent?.length ?? 0) > 0)
  );
}

function measureToolbarCollapse(): void {
  const toolbar = toolbarRef.value;
  if (!toolbar) return;
  const { valveFloor, expandMargin } = toolbarCollapseTokens();
  const width = toolbar.getBoundingClientRect().width;
  const right = toolbarRightRef.value;

  // The way back, one stage at a time, re-measured on the settled layout.
  if (modelPillGone.value) {
    if (width > modelGoneAt + expandMargin) {
      modelPillGone.value = false;
      void nextTick(measureToolbarCollapse);
    }
    return;
  }
  if (compactChipGone.value) {
    if (width > compactGoneAt + expandMargin) {
      compactChipGone.value = false;
      void nextTick(measureToolbarCollapse);
      return;
    }
    // Stage 3→4: even without the chip the row can still overflow (a working
    // turn renders Stop next to Send). The model pill is the last yield —
    // already a bare icon, and its identity and picker both live in the
    // settings sheet.
    if (right && rightClusterOverflows(right)) {
      modelGoneAt = width;
      modelPillGone.value = true;
      void nextTick(measureToolbarCollapse);
    }
    return;
  }
  if (modelPillCollapsed.value) {
    if (width > modelCollapsedAt + expandMargin) {
      modelPillCollapsed.value = false;
      void nextTick(measureToolbarCollapse);
      return;
    }
    // Stage 2→3(→4): every pill is already icon-only, so the valve element
    // is gone and cannot speak — the verdict is the right cluster
    // physically overflowing its own box (justify-end pushes its children
    // past the box's left edge). The /compact chip duplicates a slash
    // command, so it yields next; with no chip aboard (context under 80%)
    // the machine skips straight to the model pill (stage 4) instead of
    // stalling on a control that isn't there.
    if (right && rightClusterOverflows(right)) {
      if (showCompact.value) {
        compactGoneAt = width;
        compactChipGone.value = true;
      } else {
        modelGoneAt = width;
        modelPillGone.value = true;
      }
      void nextTick(measureToolbarCollapse);
    }
    return;
  }
  if (toolbarLabelsCollapsed.value && width > labelsCollapsedAt + expandMargin) {
    toolbarLabelsCollapsed.value = false;
    void nextTick(measureToolbarCollapse);
    return;
  }

  // The single verdict: the valve crushed below the floor advances exactly
  // one stage; the settled re-measure decides whether another is needed.
  const nameEl = mpNameRef.value;
  const valveExhausted =
    nameEl !== null &&
    textCrushed(nameEl) &&
    nameEl.getBoundingClientRect().width < valveFloor;
  if (!valveExhausted) return;
  if (!toolbarLabelsCollapsed.value) {
    labelsCollapsedAt = width;
    toolbarLabelsCollapsed.value = true;
  } else {
    modelCollapsedAt = width;
    modelPillCollapsed.value = true;
  }
  void nextTick(measureToolbarCollapse);
}

let toolbarLabelObserver: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !toolbarRef.value) return;
  toolbarLabelObserver = new ResizeObserver(measureToolbarCollapse);
  toolbarLabelObserver.observe(toolbarRef.value);
});
onUnmounted(() => {
  toolbarLabelObserver?.disconnect();
  toolbarLabelObserver = null;
});
// Toolbar content changes without a resize (permission switch, swarm toggle,
// compact chip, model/thinking switch, working/stop toggle, locale) shift
// the space pressure too — as does the user's font-scale setting, which
// resizes every label through --ui-font-size* without moving the toolbar
// box, the font-display:swap font settling in after load, and sign-in /
// upgrade / catalog changes swapping the right side between the login,
// upgrade and model pills. Re-evaluate against the current width; while
// collapsed, optimistically restore the labels first so eased pressure lets
// them back in — the re-measure snaps them away again if the row is still
// too tight.
const { fontScale } = useAppearance();
watch(
  [
    permLabel,
    swarmOn,
    showCompact,
    thinkingSuffix,
    () => props.status?.model,
    () => props.working,
    () => props.authReady,
    () => props.managedSignedIn,
    () => props.managedMembership,
    () => props.models?.length,
    fontScale,
    locale,
  ],
  () => {
    if (toolbarLabelsCollapsed.value) toolbarLabelsCollapsed.value = false;
    if (modelPillCollapsed.value) modelPillCollapsed.value = false;
    if (compactChipGone.value) compactChipGone.value = false;
    if (modelPillGone.value) modelPillGone.value = false;
    void nextTick(measureToolbarCollapse);
  },
);
// The shipping font swaps in after first paint (font-display: swap) and can
// change every label's width without any resize — re-measure once it lands.
onMounted(() => {
  void document.fonts?.ready.then(measureToolbarCollapse);
});

// The icon-only model pill carries its identity (name + thinking suffix) on
// the tooltip and accessible name instead of visible text.
const modelIconLabel = computed(() => `${props.status?.model ?? ''}${thinkingSuffix.value}`);

// ---------------------------------------------------------------------------
// Model dropdown — current provider models + thinking + more
// ---------------------------------------------------------------------------

const currentProvider = computed(() => {
  return currentModel.value?.provider ?? '';
});

const providerModels = computed(() => {
  if (!currentProvider.value || !props.models?.length) return [];
  return props.models.filter((m) => m.provider === currentProvider.value);
});

// No models at all (signed out / no provider configured): the model pill slot
// shows a sign-in button instead of a meaningless placeholder pill.
const hasModels = computed(() => (props.models?.length ?? 0) > 0);
// Gate on explicit unreadiness, not just an empty catalog — a failed /models
// fetch must not mislabel a signed-in, ready daemon. A signed-in managed
// account never gets the sign-in entry: a free account (userinfo probe
// rejected with 402) gets the upgrade entry, and any other signed-in state
// just leaves the slot empty.
const noUsableModels = computed(() => props.authReady === false && !hasModels.value);
const showSignIn = computed(() => noUsableModels.value && !(props.managedSignedIn ?? false));
const showUpgrade = computed(
  () => noUsableModels.value && (props.managedSignedIn ?? false) && props.managedMembership === 'free',
);

const starredSet = computed(() => new Set(props.starredIds ?? []));
function isStarred(modelId: string): boolean {
  return starredSet.value.has(modelId);
}
const starredOtherModels = computed(() => {
  if (!props.models?.length) return [];
  return props.models.filter(
    (m) => isStarred(m.id) && m.provider !== currentProvider.value,
  );
});

// Keyboard model for the quick-switch menu: focus the current row on open,
// then ArrowUp / ArrowDown cycle through the rows (Esc already closes).
const modelDropdownRef = ref<HTMLElement | null>(null);
trackMenuSurface(dropdownOpen, modelDropdownRef);

// Viewport clamp: the menu normally grows upward from the toolbar, but in
// layouts where the composer sits high in the pane (workspace home) there is
// not enough room above — flip below the toolbar when it fits better there,
// and cap the height either way so the scrollable model list (.md-list)
// absorbs the overflow while the controls below stay pinned. The gap and
// margin read the same spacing tokens the CSS anchor uses, so the two sides
// never drift; a window resize while open closes the menu (see the watcher).
// Bounds come from the VISUAL viewport — on iOS the software keyboard and
// pinch zoom shrink it without touching window.innerHeight (the App.vue
// --app-height recipe).
function clampModelMenuToViewport(): void {
  const menu = modelDropdownRef.value;
  const toolbar = toolbarRef.value;
  if (!menu || !toolbar) return;
  const style = getComputedStyle(menu);
  const gap = cssPx(style.getPropertyValue('--space-1')) || 4; // menu ↔ toolbar offset
  const margin = cssPx(style.getPropertyValue('--space-2')) || 8; // viewport breathing room
  const vv = window.visualViewport;
  const viewportTop = vv?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (vv?.height ?? window.innerHeight);
  const rect = toolbar.getBoundingClientRect();
  const above = rect.top - viewportTop - gap - margin;
  const below = viewportBottom - rect.bottom - gap - margin;
  if (menu.offsetHeight > above && below > above) {
    modelMenuDropDown.value = true;
    modelMenuMaxHeight.value = `${Math.max(Math.floor(below), 0)}px`;
  } else {
    modelMenuDropDown.value = false;
    modelMenuMaxHeight.value = `${Math.max(Math.floor(above), 0)}px`;
  }
}

// A resize / rotation while the menu is open invalidates the clamp — close
// the menu, the same convention as the app's other anchored menus.
function onViewportResize(): void {
  closeDropdown();
}

function addModelMenuViewportListeners(): void {
  window.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('scroll', onViewportResize);
}

function removeModelMenuViewportListeners(): void {
  window.removeEventListener('resize', onViewportResize);
  window.visualViewport?.removeEventListener('resize', onViewportResize);
  window.visualViewport?.removeEventListener('scroll', onViewportResize);
}

watch(dropdownOpen, async (open) => {
  if (!open) {
    removeModelMenuViewportListeners();
    return;
  }
  addModelMenuViewportListeners();
  // Reset the previous open's clamp so the natural height is measured.
  modelMenuDropDown.value = false;
  modelMenuMaxHeight.value = '';
  await nextTick();
  clampModelMenuToViewport();
  const current =
    modelDropdownRef.value?.querySelector<HTMLElement>('.md-row.is-current') ??
    modelDropdownRef.value?.querySelector<HTMLElement>('.md-row');
  current?.focus();
});

onUnmounted(() => {
  removeModelMenuViewportListeners();
});

function onModelDropdownKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(
    modelDropdownRef.value?.querySelectorAll<HTMLElement>('.md-row:not(:disabled)') ?? [],
  );
  if (!rows.length) return;
  event.preventDefault();
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'ArrowDown' ? (index + 1) % rows.length : (index - 1 + rows.length) % rows.length;
  rows[next]?.focus();
}

function selectModel(modelId: string): void {
  emit('selectModel', modelId);
  closeDropdown();
}
</script>

<template>
  <div
    class="composer"
    :class="{ 'drag-over': isDragOver, expanded }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Pending-attachment preview: the same MediaLightbox the sent-message
         chips open. -->
    <MediaLightbox
      v-if="previewMedia"
      :media="previewMedia"
      :origin-img="previewThumbImg"
      @close="
        previewThumbImg = null;
        closeAttachmentPreview();
      "
    />

    <!-- Main composer card -->
    <div class="composer-card" :class="{ 'labels-collapsed': toolbarLabelsCollapsed }">
      <!-- Attachment previews (inside the card, above the input row): the
           strip is MEDIA-ONLY (image/video thumbnails) — files and folders
           are in-document pills now, rendered by the editor itself. The
           strip caps at two thumbnail rows and scrolls beyond that;
           clear-all stays pinned to the top corner so it never scrolls
           away. -->
      <div v-if="attachments.length > 0" class="att-strip">
        <div ref="attScrollRef" class="att-scroll" :class="{ 'is-overflowing': attOverflowing }">
          <div ref="attScrollContentRef" class="att-scroll-content">
            <div v-if="mediaDrafts.length > 0" class="att-row att-row-media">
              <MediaThumb
                v-for="att in mediaDrafts"
                :key="att.localId"
                :kind="att.kind"
                :name="att.name"
                :url="att.previewUrl"
                :file-id="att.fileId"
                :session-id="att.sessionId"
                :uploading="att.uploading"
                :error="att.error"
                removable
                :remove-label="t('composer.removeNamed', { name: att.name })"
                @activate="onAttachmentActivate(att, $event)"
                @remove="removeAttachment(att.localId)"
              />
            </div>
          </div>
        </div>
        <span v-if="attOverflowing" class="att-more">{{ t('composer.attachmentCount', { n: attachments.length }) }}</span>
        <Tooltip v-if="attachments.length >= 2" :text="t('composer.clearAll')">
          <IconButton class="att-clear" size="sm" :label="t('composer.clearAll')" @click="clearAttachments">
            <Icon name="trash" />
          </IconButton>
        </Tooltip>
      </div>

      <!-- Input row with popup menus -->
      <div class="cin-wrap">
        <!-- Slash menu (above textarea) -->
        <SlashMenu
          v-if="slashOpen"
          ref="slashMenuRef"
          :items="slashItems"
          :ranges="slashRanges"
          :active-index="slashActive"
          :query="slashQuery"
          @select="selectSlashCommand"
          @hover="slashActive = $event"
        />

        <!-- Mention menu (above textarea) -->
        <MentionMenu
          v-if="mentionOpen"
          ref="mentionMenuRef"
          :items="mentionItems"
          :active-index="mentionActive"
          :loading="mentionLoading"
          :stale="mentionFileStale"
          @select="selectMentionItem"
          @hover="mentionNavigate"
        />

        <!-- Add menu: the composer's action list — the autocomplete family's
             surface and rows, with real menu semantics (focus moves in,
             arrows navigate, Enter activates, Escape closes). -->
        <Transition name="composer-menu-pop">
          <div v-if="addMenuOpen" ref="addMenuRef" class="add-menu" @click.stop @keydown="onAddMenuKeydown">
            <div ref="addScrollRef" class="am-scroll" role="menu" @scroll="onAddMenuScroll">
              <button
                v-for="item in addItems"
                :key="item.id"
                type="button"
                class="am-row"
                role="menuitem"
                @mousedown.prevent
                @click="selectAddItem(item)"
              >
                <span class="am-icon"><Icon :name="item.icon" size="sm" /></span>
                <span class="am-name">{{ t(item.nameKey) }}</span>
                <span v-if="item.descKey" class="am-desc">{{ t(item.descKey) }}</span>
              </button>
            </div>
            <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
            <div v-if="addThumb" class="scroll-thumb" :style="{ top: `${addThumb.top}px`, height: `${addThumb.height}px` }" />
          </div>
        </Transition>

        <div class="input-row">
          <!-- ProseMirror mounts inside this host (see script). The host keeps
               the .ph styling + the data-empty/data-wm flags; combobox ARIA
               lives on the PM root (the focusable element), set imperatively.
               The work-mode pill and the empty-doc placeholder are widget
               decorations INSIDE the editor (see workModePill.ts) — in-flow
               at the document head, never document content. -->
          <div
            ref="editorHostRef"
            class="ph"
            :data-empty="text.length === 0"
            :data-wm="workMode ? 'true' : 'false'"
          ></div>
          <Tooltip :text="expanded ? t('composer.collapseTitle') : t('composer.expandTitle')">
          <button
            v-if="expanded || isGrown"
            class="expand-btn"
            type="button"
            :aria-label="expanded ? t('composer.collapseTitle') : t('composer.expandTitle')"
            @click="toggleExpand"
          >
            <Icon v-if="expanded" name="collapse" size="sm" />
            <Icon v-else name="expand" size="sm" />
          </button>
          </Tooltip>
        </div>
      </div>

      <!-- Hidden file input (no accept filter — any file type can be attached) -->
      <input
        v-if="hasUpload"
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileInputChange"
      />

      <!-- Bottom toolbar — split into individual controls -->
      <div ref="toolbarRef" class="toolbar">
        <div ref="menuMeasureRef" class="menu-measure" aria-hidden="true">
          <span class="pd-desc" />
        </div>

        <!-- Left: attach + permission + swarm -->
        <div class="toolbar-left">
          <!-- Add menu: files + work modes (goal / plan). -->
          <IconButton
            class="composer-attach"
            size="md"
            :label="t('composer.addMenu')"
            :tooltip="t('composer.addMenu')"
            aria-haspopup="menu"
            :aria-expanded="addMenuOpen"
            @mousedown.prevent
            @click.stop="toggleAddMenu"
          >
            <Icon name="plus" />
          </IconButton>

          <!-- Permission pill — click to open dropdown. Icon-only collapsed:
               the mode identity moves to the tooltip. -->
          <Tooltip v-if="status" :text="toolbarLabelsCollapsed ? permLabel : null">
            <span
              ref="permPillRef"
              class="perm-pill"
              :class="['perm-' + status.permission, { open: permDropdownOpen }]"
              role="button"
              tabindex="0"
              :aria-label="permLabel"
              @click.stop="togglePermDropdown"
              @keydown.enter="togglePermDropdown"
              @keydown.space.prevent="togglePermDropdown"
            >
              <Icon class="perm-pill-icon" :name="permIcon" size="md" />
              <span class="perm-pill-label">{{ permLabel }}</span>
            </span>
          </Tooltip>

          <!-- Permission dropdown — left-aligned to its trigger pill. -->
          <Transition name="composer-menu-pop">
            <div
              v-if="permDropdownOpen && status"
              ref="permDropdownRef"
              class="perm-dropdown"
              :style="permissionMenuStyle"
              role="menu"
              @click.stop
            >
              <button
                v-for="opt in PERM_MODES"
                :key="opt.mode"
                class="pd-row"
                :class="{ 'is-current': opt.mode === status.permission }"
                role="menuitem"
                @click="choosePermission(opt.mode)"
              >
                <span class="pd-icon" :style="{ color: opt.color }"><Icon :name="opt.icon" size="md" /></span>
                <span class="pd-info">
                  <span class="pd-name" :style="{ color: opt.color }">{{ t(opt.labelKey) }}</span>
                  <span class="pd-desc">{{ t(opt.descKey) }}</span>
                </span>
                <span class="pd-check"><Icon v-if="opt.mode === status.permission" name="check" size="sm" /></span>
              </button>
            </div>
          </Transition>

          <!-- Swarm — an agent-usage toggle, deliberately NOT a work mode.
               Enabled only via the add menu or /swarm; while on, this state
               chip sits in the toolbar and its hover × switches it off. -->
          <span v-if="swarmOn" class="swarm-chip">
            <Icon class="swarm-ic" name="sparkles" size="md" />
            <span class="swarm-label">{{ t('status.swarmLabel') }}</span>
            <IconButton
              class="swarm-x"
              size="sm"
              :label="t('status.swarmDismiss')"
              :tooltip="t('status.swarmDismiss')"
              @mousedown.prevent
              @click.stop="emit('toggleSwarm')"
            >
              <Icon name="close" size="sm" />
            </IconButton>
          </span>

        </div>

        <!-- Right: ctx + model -->
        <div ref="toolbarRightRef" class="toolbar-right">
          <!-- Compact chip when context is high; the toolbar collapse's final
               stage hides it first (it only duplicates the /compact command). -->
          <button v-if="showCompact" class="compact-chip" :class="{ gone: compactChipGone }" @click.stop="emit('compact')">/compact</button>

          <!-- Context meter — circular ring only; the full usage (used/max/pct)
               lives in the tooltip. The ring is aria-hidden, so the trigger
               exposes those numbers via aria-label; focusable so keyboard and
               switch-control users reach the same tooltip hover users see. -->
          <Tooltip :text="ctxTooltip">
            <span
              v-if="status && !hideContext"
              class="ctx-group"
              role="img"
              tabindex="0"
              :aria-label="ctxTooltip"
            >
              <ContextRing :pct="pct" />
            </span>
          </Tooltip>

          <!-- Model pill — click to open quick-switch dropdown. The toolbar's
               final yield stage: the thinking suffix never truncates, and once
               the model name is crushed below readability the pill sheds its
               text and chevron for the bare model icon; the tooltip keeps the
               identity. -->
          <Tooltip v-if="status && !showSignIn && !showUpgrade" :text="modelPillCollapsed ? modelIconLabel : null">
          <button
            ref="modelPillRef"
            type="button"
            class="model-pill"
            :class="{ open: dropdownOpen, 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            aria-haspopup="menu"
            :aria-expanded="dropdownOpen"
            :aria-label="modelPillCollapsed ? modelIconLabel : undefined"
            @click.stop="toggleDropdown"
          >
            <Icon v-if="modelPillCollapsed" name="model" size="md" />
            <template v-else>
              <span ref="mpNameRef" class="mp-name">{{ status.model }}</span>
              <span v-if="thinkingSuffix" class="think-suffix">{{ thinkingSuffix }}</span>
              <Icon class="cv" name="chevron-down" size="sm" />
            </template>
          </button>
          </Tooltip>
          <!-- Signed-in free managed account / no usable models — the pill slot
               becomes the upgrade entry (external link). It plays the model
               pill's role in the collapse: its name is the same valve, and it
               sheds to its bare icon (then yields entirely) on the same stages. -->
          <button
            v-else-if="status && showUpgrade"
            type="button"
            class="model-pill login-pill"
            :class="{ 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            :aria-label="modelPillCollapsed ? t('sidebar.upgrade') : undefined"
            @click.stop="openUpgrade()"
          >
            <Icon v-if="modelPillCollapsed" name="music" size="md" />
            <template v-else>
              <Icon name="music" size="sm" />
              <span ref="mpNameRef" class="mp-name">{{ t('sidebar.upgrade') }}</span>
            </template>
          </button>
          <!-- Signed out / no models — the pill slot becomes the sign-in entry
               (deep-links into the settings account tab). It plays the model
               pill's role in the collapse: its name is the same valve, and it
               sheds to its bare icon (then yields entirely) on the same stages. -->
          <button
            v-else-if="status && showSignIn"
            type="button"
            class="model-pill login-pill"
            :class="{ 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            :aria-label="modelPillCollapsed ? t('login.action') : undefined"
            @click.stop="emit('login')"
          >
            <Icon v-if="modelPillCollapsed" name="log-in" size="md" />
            <template v-else>
              <Icon name="log-in" size="sm" />
              <span ref="mpNameRef" class="mp-name">{{ t('login.action') }}</span>
            </template>
          </button>
          <Tooltip v-if="working" :text="t('composer.interruptTitle')">
            <button
              class="stop"
              :aria-label="t('composer.interrupt')"
              @click="emit('interrupt')"
            >
              <Icon name="stop" size="sm" />
            </button>
          </Tooltip>
          <Tooltip :text="sendLabel">
          <button
            class="send"
            :class="{ 'is-starting': starting }"
            :aria-label="sendLabel"
            :disabled="starting || !canSend"
            @click="handleSubmit()"
          >
            <Spinner v-if="starting" size="sm" />
            <Icon v-else name="send" size="sm" />
          </button>
          </Tooltip>
        </div>

        <!-- Model dropdown — current provider models + controls + more -->
        <Transition name="composer-menu-pop">
        <div
          v-if="dropdownOpen && status"
          ref="modelDropdownRef"
          class="model-dropdown"
          :class="{ 'flip-down': modelMenuDropDown }"
          :style="modelMenuStyle"
          role="menu"
          @click.stop
          @keydown="onModelDropdownKeydown"
        >
          <!-- Scrollable model list — capped so a large provider catalog
               can't push the controls below out of the viewport. -->
          <div class="md-list">
            <!-- Starred models from other providers -->
            <div v-if="starredOtherModels.length > 0" class="md-section">{{ t('status.starredModels') }}</div>
            <button
              v-for="m in starredOtherModels"
              :key="m.id"
              class="md-row"
              :class="{ 'is-current': m.id === status.modelId }"
              role="menuitem"
              @click="selectModel(m.id)"
            >
              <span class="md-check"><Icon v-if="m.id === status.modelId" name="check" size="sm" /></span>
              <span class="md-name">{{ m.displayName ?? m.model }}</span>
              <span class="md-provider">{{ m.provider }}</span>
              <Icon class="md-star" name="star" size="sm" />
            </button>

            <div v-if="starredOtherModels.length > 0" class="md-divider" />

            <!-- Current provider models -->
            <div v-if="providerModels.length > 0" class="md-section">{{ currentProvider }}</div>
            <button
              v-for="m in providerModels"
              :key="m.id"
              class="md-row"
              :class="{ 'is-current': m.id === status.modelId }"
              role="menuitem"
              @click="selectModel(m.id)"
            >
              <span class="md-check"><Icon v-if="m.id === status.modelId" name="check" size="sm" /></span>
              <span class="md-name">{{ m.displayName ?? m.model }}</span>
              <Icon v-if="isStarred(m.id)" class="md-star" name="star" size="sm" />
            </button>
          </div>

          <div v-if="providerModels.length > 0" class="md-divider" />

          <!-- Thinking level — the shared segmented control (same as settings
               and the mobile sheet). Unsupported shows a note; a single fixed
               segment degrades to a static value instead of a dead control. -->
          <div class="md-thinking">
            <span class="md-name">{{ t('status.thinkingLabel') }}</span>
            <span
              v-if="thinkingAvailability === 'unsupported'"
              class="md-note"
            >{{ t('status.modeNotSupported') }}</span>
            <SegmentedControl
              v-else-if="thinkingSegments.length > 1"
              :model-value="activeThinkingSegment"
              :options="thinkingOptions"
              size="xs"
              @update:model-value="setThinkingSegment"
            />
            <span v-else class="md-note">{{ thinkingSegmentLabel(thinkingSegments[0] ?? thinkingLevel) }}</span>
          </div>

          <div class="md-divider" />
          <div class="md-cache-note">{{ t('status.cacheNote') }}</div>

          <div class="md-divider" />

          <!-- More models → open full picker -->
          <button class="md-row md-row-more" role="menuitem" @click="closeDropdown(); emit('pickModel');">
            <span class="md-check md-more-icon"><Icon name="list" size="sm" /></span>
            <span class="md-name">{{ t('status.moreModels') }}</span>
            <Icon class="md-more-arrow" name="chevron-right" size="sm" />
          </button>
        </div>
        </Transition>
      </div>
  </div>

  <!-- Optional footer (empty-session workspace picker) — a sibling of the
       card, so the attachment can tuck under the complete card shell. -->
  <div v-if="$slots.footer" class="composer-footer">
    <slot name="footer" />
  </div>
  <!-- Full-window drop target affordance: shown while files are dragged anywhere
       over the app (document-level listeners in useAttachmentUpload). Pure CSS
       show/hide — a Vue <Transition> can strand an invisible node when the drag
       ends before the enter transition starts. -->
  <div class="drop-overlay" :class="{ show: isDragOver }" aria-hidden="true">
    <div class="drop-card">
      <Icon name="file-plus" size="lg" />
      <span>{{ t('composer.dropToAttach') }}</span>
    </div>
  </div>
</div>
</template>

<style scoped>
.composer {
  padding: 7px var(--dock-inline-right, 16px) 12px var(--dock-inline-left, 16px);
  background: transparent;
  transition: background 0.12s;
}

.composer.drag-over {
  background: var(--color-accent-soft);
}

/* Full-window drop overlay: pointer-events none — the document-level handlers
   in useAttachmentUpload receive the drop, the overlay is purely visual. */
.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-bg) 72%, transparent);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-base) ease,
    visibility var(--duration-base);
}
.drop-overlay.show {
  opacity: 1;
  visibility: visible;
}
.drop-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-lg);
  border: 0.5px dashed var(--color-accent);
  background: var(--color-bg);
  color: var(--color-accent);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-md);
}

/* Main composer card */
.composer-card {
  --composer-control-size: var(--space-8);
  --composer-send-size: var(--composer-control-size);
  --composer-control-inset: var(--space-2);
  /* Toolbar collapse thresholds, read by the JS measure via getComputedStyle.
     em so they track the UI font scale — the floor keeps ≈8 Latin chars of
     the model name readable (name + version stays visible); ≈56px / ≈48px
     at the 14px base. Sizes belong to the token system, not the script. */
  --composer-valve-floor: 4em;
  --composer-valve-expand-margin: 3.4em;
  position: relative;
  border: 0.5px solid var(--color-composer-line);
  border-radius: var(--radius-composer);
  corner-shape: var(--corner-shape-composer);
  background: var(--color-composer-bg);
  box-shadow: var(--shadow-input);
  user-select: none;
  container-type: inline-size;
}
.composer-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border: inherit;
  border-color: var(--color-composer-focus-line);
  border-radius: var(--radius-composer);
  corner-shape: var(--corner-shape-composer);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-slow) var(--ease-in-out);
}
.composer-card:focus-within::after {
  opacity: 1;
}



/* Attachment strip — media-only now (files/folders are in-document pills);
   thumbs are the shared MediaThumb, this is only the layout inside the card.
   Capped at two thumbnail rows: beyond that the strip scrolls instead of
   pushing the input down. The right margin shifts the scrollbar off the
   corner, so the pinned clear-all button never overlaps it. */
.att-strip {
  position: relative;
  /* Top/left --space-4 + --space-05: the chip's corner lands exactly
     concentric with the card's (chip radius 14 + 18 = the card corner's
     32px center). */
  padding: calc(var(--space-4) + var(--space-05)) var(--space-4) 0 calc(var(--space-4) + var(--space-05));
}
.att-scroll {
  max-height: calc(128px + var(--space-2));
  overflow-y: auto;
  margin-right: calc(var(--icon-button-sm) + var(--space-1));
}
.att-scroll-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-right: var(--space-1);
}
/* Overflowing: room at the bottom so the last row can scroll above the
   count badge. */
.att-scroll.is-overflowing {
  padding-bottom: var(--space-6);
}
/* Overflow count badge — pinned to the strip's bottom-left, inert. */
.att-more {
  position: absolute;
  left: var(--space-4);
  bottom: var(--space-1);
  z-index: var(--z-raised);
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 var(--space-2);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
}
.att-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.att-row-media {
  gap: var(--space-2);
}
/* Clear-all: the shared IconButton, pinned to the strip's top corner. */
.att-clear {
  position: absolute;
  top: calc(var(--space-4) + var(--space-05));
  right: var(--space-4);
  z-index: var(--z-raised);
}

/* Hidden file input */
.file-input-hidden {
  display: none;
}

/* Wrapper that establishes a positioning context for the popup menus */
.cin-wrap {
  position: relative;
  padding: 14px 16px 8px;
}

/* Input row */
.input-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

/* Expand toggle — top-right of the textarea */
.expand-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  padding: 0;
  transition: background 0.12s, color 0.12s;
}

.expand-btn:hover {
  background: var(--panel2);
  color: var(--color-text);
}

.expand-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.ph {
  color: var(--faint);
  /* Keep the caret at the normal text colour even when the field is empty:
     the empty state sets `color` to `--faint` (so the placeholder feels soft),
     and an unset caret inherits that faint colour and nearly disappears. */
  caret-color: var(--color-text);
  flex: 1;
  border: none;
  outline: none;
  font-family: var(--font-ui);
  font-size: var(--content-font-size);
  text-autospace: normal;
  background: transparent;
  min-height: 36px;
  max-height: calc(var(--app-height, 100dvh) / 4);
  overflow-y: auto;
  scrollbar-width: none;
  line-height: 1.5;
  margin-bottom: 6px;
  user-select: text;
}

.ph::-webkit-scrollbar {
  display: none;
}

.ph:not([data-empty='true']) {
  color: var(--color-text);
}

/* The ProseMirror root is created at runtime inside the host — :deep() reaches
   it. Keep its paragraphs margin-free so lines pack exactly like the textarea
   they replaced. */
.ph :deep(.ProseMirror) {
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  /* Fill the host's minimum box (36px resting / 70%-of-app-height expanded) so clicking
     anywhere in the visible editor area lands on the contenteditable and can
     focus/place the caret — not on the inert host below the last line. */
  min-height: inherit;
}

.ph :deep(.ProseMirror p) {
  margin: 0;
}

/* PM appends a trailing <br> when a paragraph ends with an inline atom (a
   caret target after the pill). Rendered, it reads as an unwanted extra
   line after the pill — hide it, except when it is the paragraph's only
   content (the empty-paragraph placeholder line needs it). */
.ph :deep(.ProseMirror-trailingBreak:not(:only-child)) {
  display: none;
}

/* Mention pills (file/folder/skill atoms): the visual vocabulary is global
   (app-ui/style.css, shared with rendered messages). Editor-only: when the
   atom is node-selected (first Backspace selects, second deletes), the ink
   deepens to full text color to mark the pending deletion. */
.ph :deep(.mention-pill.ProseMirror-selectednode) {
  color: var(--color-text);
}

/* The work-mode pill and the empty-doc placeholder are widget decorations
   inside the editor (built by app-composer's workModePill) — in-flow at the
   document head, so they scroll with the text and need no measured indent.
   The pill is exactly one line box tall (it shares the textarea's font-size
   and line-height so its label sits on the first line's baseline), pulled
   left --space-05 into the armed scrollport's padding-left reserve (see the
   reserve rule below — without it the rounded cap would be clipped flat at
   the .ph edge) to keep the inset concentric (14px on both sides), with a
   --space-1-5 gap to the text. */
.ph :deep(.wm-pill) {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  vertical-align: top;
  height: calc(var(--content-font-size) * 1.5);
  margin-left: calc(-1 * var(--space-05));
  margin-right: var(--space-1-5);
  padding: 0 calc((var(--content-font-size) * 1.5 - var(--wm-x-size)) / 2) 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  /* The fills ladder's --color-selected rung (same fill as the dock's work
     pills): dark's --color-surface equals --color-composer-bg, so a surface
     chip vanished into the composer card there — the translucent fill reads
     on both themes. The mobile / touch-lane rules below only re-lay the
     pill, so this one fill covers every state. */
  background: var(--color-selected);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: calc(var(--content-font-size) * 1.5);
  white-space: nowrap;
  user-select: none;
}

.ph :deep(.wm-icon) {
  display: inline-flex;
}

/* The × is a plain <button> on widget DOM, hand-built to the IconButton
   contract (Vue primitives can't reach it — same exception as the mention
   tooltip's buttons): muted idle ink deepening on a hover wash, --p-focus-ring
   on keyboard focus. Sized to the pill's right-end reserve (--wm-x-size) —
   below the sm default so the hover wash never outgrows the pill's rounded
   end; the clickable area grows past its box via a transparent ring, which on
   touch meets the --touch-target-min floor inside the pill's own lane (see
   the hover:none lane rule at the end of this sheet). */
.ph :deep(.wm-x) {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--wm-x-size);
  height: var(--wm-x-size);
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.ph :deep(.wm-x:hover) {
  background: var(--color-hover);
  color: var(--color-text);
}
.ph :deep(.wm-x:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.ph :deep(.wm-x)::before {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--wm-x-ring));
}

/* The ×'s focus ring (--p-focus-ring, 3px) reaches past the button, which is
   centered in the pill with only a couple px of air above — and the pill sits
   flush at the top of the .ph scrollport, so the ring's upper half would be
   clipped. Reserve real scrollport headroom while armed — and a --space-05
   inline reserve too: the pill's negative left margin pulls its rounded cap
   2px past the text column, which the scrollport would otherwise clip flat. */
.ph[data-wm='true'] :deep(.ProseMirror) {
  padding-top: var(--space-1);
  padding-left: var(--space-05);
}

/* The placeholder line (widget decoration, empty docs only): muted, inert —
   clicks fall through to the paragraph and focus the editor. */
.ph :deep(.wm-placeholder) {
  color: var(--muted);
  pointer-events: none;
  user-select: none;
}

/* Shortcut keycaps in the placeholder (the copy's whitelisted <kbd> pairs):
   the §03 Kbd look, geometry from the shared --kbd-* / --p-hairline tokens,
   colour inherited from the placeholder text. */
.ph :deep(.wm-placeholder kbd) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--kbd-min-width);
  height: var(--kbd-height);
  padding: 0 var(--kbd-padding-x);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font-family: var(--font-kbd);
  font-size: var(--kbd-font-size);
  line-height: var(--leading-solid);
}

/* Expanded editor: a tall composing area at ~70% of the viewport — clearly
   larger than the auto-grow cap, while leaving room for the chat header, the
   bottom toolbar row, and padding so nothing gets clipped. Content beyond it
   scrolls internally. */
.composer.expanded .ph {
  min-height: calc(var(--app-height, 100dvh) * 0.7);
  max-height: calc(var(--app-height, 100dvh) * 0.7);
}

/* /compact chip */
.compact-chip {
  height: var(--composer-control-size);
  padding: 0 var(--space-2);
  border: 0.5px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-warning);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  cursor: pointer;
  line-height: 1;
  flex: none;
  transition: background var(--duration-base) var(--ease-out);
}
.compact-chip:hover { background: var(--color-hover); }
/* Stage 3 of the toolbar collapse (see measureToolbarCollapse): when even
   the icon-only row cannot fit, the chip — a convenience duplicate of the
   /compact command — is the next control to yield. */
.compact-chip.gone { display: none; }
/* Stage 4: the row can STILL overflow without the chip (a working turn adds
   Stop next to Send) — the model pill, already a bare icon whose identity
   and picker live one settings-sheet tap away, yields last. */
.model-pill.model-gone { display: none; }

/* Keep the shared attachment icon and behavior; only its Composer-local
   geometry joins the full-round 32px control family. */
.composer-attach {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  border-radius: var(--radius-full);
  flex: none;
}

/* Add menu — a composer-wide action list above the composer (the
   autocomplete menus' spot), sharing the dock panel's frosted material and
   a plain 12px corner (no superellipse — the composer card keeps its own
   geometry). */
.add-menu {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  z-index: var(--z-dropdown);
  background: var(--color-menu-bg-frost);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  padding: var(--space-1-5) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--menu-rows-seam);
  font-family: var(--font-ui);
  transform-origin: bottom left;
}
/* The scroll container (caps long menus — e.g. short viewports — at the
   shared add-menu height). Same scrollport trick as the slash/mention menus:
   margin −6 / padding 6 puts the horizontal clip exactly on the rows' outer
   edge. The native bar stays hidden — it would eat 6px of row width and skew
   the rows' right inset; the overlay thumb is the scroll affordance. */
.am-scroll {
  max-height: var(--p-add-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  gap: var(--menu-rows-seam);
}
.am-scroll::-webkit-scrollbar { display: none; }
/* The overlay thumb (same vocabulary as the slash/mention menus): floats at
   the menu's right edge, pointer-transparent, deeper on menu hover. Geometry
   is computed in updateAddScrollState. */
.scroll-thumb {
  position: absolute;
  right: var(--menu-scrollbar-edge);
  width: var(--menu-scrollbar-width);
  border-radius: var(--radius-full);
  background: var(--color-menu-scrollbar);
  transition: background var(--duration-base) var(--ease-out);
  pointer-events: none;
  z-index: var(--z-raised);
}
.add-menu:hover .scroll-thumb {
  background: var(--color-menu-scrollbar-hover);
}
.am-row {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  /* NO width: 100% — a fixed percentage width pins the row to the wrapper's
     content box and the scrollport swallows the right negative margin
     (inline-end outreach never counts as scrollable overflow), leaving the
     row 6px from the left edge but 18px from the right. Stretch (width auto)
     lets the flex algorithm fold BOTH margins into the cross size, so the
     row hugs 6px from each edge — same as the slash/mention rows. Box hugs
     6px from the menu edge while the content lands on the composer's 16px
     text column; --radius-menu-row keeps the row caps concentric with the
     12px menu frame (12px − 6px hug). */
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--menu-row-padding-block) var(--menu-row-padding-inline);
  /* A <button> — without this the UA default border shows through. */
  border: none;
  border-radius: var(--radius-menu-row);
  background: none;
  cursor: pointer;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  text-align: left;
  transition: background var(--duration-base) var(--ease-out);
}
.am-row:hover { background: var(--color-hover); }
/* Keyboard-driven focus (the menu takes DOM focus on open) carries the
   selected wash — same recipe as the autocomplete rows' active state. */
.am-row:focus-visible { background: var(--color-selected); outline: none; }
/* Touch: menu rows meet the 44px minimum hit height. */
@media (hover: none) {
  .am-row {
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}
.am-row:hover .am-icon,
.am-row:focus-visible .am-icon { color: var(--color-text); }
.am-icon {
  flex: none;
  width: var(--p-ic-sm);
  display: flex;
  justify-content: center;
  color: var(--color-text-muted);
  transition: color var(--duration-base) var(--ease-out);
}
.am-name {
  flex: none;
  font-weight: var(--weight-medium);
}
.am-desc {
  margin-left: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--ui-font-size-sm);
}

/* Send button — circular icon. Always "send"; while running it enqueues
   (handled upstream). Interrupt is a separate Stop button so the two are never
   confused. Fill/icon/shadow run on the dedicated --color-send-* tokens (the
   production kimiwork neutral recipe, see app-ui style.css). */
.send {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: var(--radius-full);
  background: var(--color-send-bg);
  color: var(--color-send-icon); /* reads on the send fill in light and dark */
  border: none;
  box-shadow: var(--shadow-send);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-slow) var(--ease-out), transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-slow) var(--ease-out);
  position: relative;
}

.send:hover:not(:disabled) {
  background: var(--color-send-bg-hover);
  box-shadow: var(--shadow-send-hover);
}

.send:active {
  transform: scale(0.92);
}

.send:disabled {
  cursor: not-allowed;
  background: var(--color-send-bg-disabled);
  color: var(--color-send-icon-disabled);
  opacity: var(--opacity-send-disabled);
}

.send:disabled:active {
  transform: none;
}

/* Starting is a working state, not an empty one: the button keeps the active
   send fill (clicks stay blocked) and the spinner arc is recolored to read on
   it. Spinner.vue styles are scoped, so pierce them with :deep(). */
.send.is-starting:disabled {
  background: var(--color-send-bg);
  color: var(--color-send-icon);
}
.send.is-starting :deep(.ui-spinner) {
  color: var(--color-send-icon);
}

.send.is-starting :deep(.ui-spinner__track) {
  stroke: color-mix(in srgb, var(--color-send-icon) 32%, transparent);
}

.send svg {
  flex: none;
  width: var(--composer-send-icon-size);
  height: var(--composer-send-icon-size);
}

/* Stop button — sibling of Send, shown only while running. Neutral wash with
   a red glyph at rest (no border, softened to 72% alpha in dark via
   --color-stop-glyph); fills solid danger on hover. */
.stop {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: var(--radius-full);
  background: var(--color-subtle);
  color: var(--color-stop-glyph);
  border: none;
  box-shadow: var(--shadow-xs);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.16s ease, color 0.16s ease, transform 0.12s ease;
}
.stop:hover {
  background: var(--color-danger);
  color: var(--color-text-on-accent);
}
.stop:active {
  transform: scale(0.92);
}
.stop svg {
  flex: none;
  width: var(--composer-send-icon-size);
  height: var(--composer-send-icon-size);
}

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Keeps the left and right control clusters from kissing once the free
     space between them is gone. */
  gap: var(--space-2);
  padding: var(--space-1) var(--composer-control-inset) var(--composer-control-inset);
  position: relative;
}

.menu-measure {
  position: absolute;
  width: max-content;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
/* The left cluster is rigid: its pills never crush — under pressure they flip
   straight from full text to icon circles (see the toolbar collapse measure),
   so there is no crushed intermediate state to clip. overflow stays only as a
   backstop; the right side keeps its no-clip rule (clipping it would shave
   the Send button's lift shadow). */
.toolbar-left { flex: none; overflow: hidden; }
.toolbar-right {
  /* The right side holds the row's only valve (the model name): it takes the
     whole deficit, then the whole recovery when a collapsed stage frees room. */
  flex: 1 1 auto;
  justify-content: flex-end;
}

/* Quiet, full-round 32px controls. Their chrome appears only on hover/open,
   leaving the circular Send as the toolbar's sole persistent filled action. */
.perm-pill,
.swarm-chip,
.model-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--composer-control-size);
  padding: 0 var(--space-3);
  border: 0.5px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.perm-pill {
  font-size: var(--ui-font-size-sm);
}
/* The hover wash floats over the fill as its own layer so it can fade in and
   out (the dock work pills' recipe — background gradients can't transition). */
.perm-pill::after,
.swarm-chip::after,
.model-pill::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: var(--color-hover);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  pointer-events: none;
}
.perm-pill:hover::after,
.swarm-chip:hover::after,
.model-pill:hover::after {
  opacity: 1;
}
.perm-pill.open,
.model-pill.open {
  background: var(--color-accent-soft);
}
/* The swarm state chip keeps the plain control chrome — no fill, no accent
   ink — and is inert except for its ×. */
.swarm-chip {
  cursor: default;
}
/* The × stays hidden until the chip is hovered (or the × itself holds
   keyboard focus). Its circle nests concentrically in the pill's rounded
   end — the negative margin lands the IconButton's centre on the cap's
   centre: cap centre (control-size/2) − padding-right (--space-3) − button
   radius (--icon-button-sm/2), all on tokens, so the hover ring sits at an
   even inset from the cap. */
.swarm-x {
  margin-right: calc(var(--composer-control-size) / 2 - var(--space-3) - var(--icon-button-sm) / 2);
  color: inherit;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
/* The × sits on circular surfaces in every state — nested in the pill's
   rounded cap when the label shows, covering the icon-only circle when
   collapsed — so its hover wash is always a circle, never the IconButton
   primitive's rounded rect. (Two classes to outrank the primitive's own
   scoped radius rule.) */
.swarm-chip .swarm-x {
  border-radius: var(--radius-full);
}
.swarm-chip:hover .swarm-x,
.swarm-x:focus-visible {
  opacity: 1;
}
/* Touch (no hover): the × stays visible — an invisible button that still
   hit-tests is an accidental-dismiss trap — with a --touch-target-min hit
   ring around the --icon-button-sm button. */
@media (hover: none) {
  /* toolbar-left shrink-wraps its content and clips its overflow, and the
     chip sits flush at the group's right edge — the ×'s hit ring reaches
     (44−26)/2 = 9px past the button, ~5px beyond the chip, and would be
     clipped (hit area and all) below the touch target. Give the chip that
     much breathing room. */
  .swarm-chip {
    margin-right: calc((var(--touch-target-min) - var(--icon-button-sm)) / 2 - var(--space-1));
  }
  .swarm-x {
    opacity: 1;
    position: relative;
  }
  .swarm-x::before {
    content: '';
    position: absolute;
    /* The hit area spans --touch-target-min around the --icon-button-sm
       button: expand by half the difference, so it stays centered and on
       spec at any scale. */
    inset: calc(-1 * (var(--touch-target-min) - var(--icon-button-sm)) / 2);
  }
}


/* Permission pill — per-state label colors. */
.perm-pill.perm-manual {
  color: var(--dim);
}
.perm-pill.perm-yolo {
  color: var(--color-warning);
}
.perm-pill.perm-auto {
  color: var(--color-danger);
}
.perm-pill-icon {
  flex: none;
}

/* The permission / swarm pills are rigid parts of the left cluster: their
   labels never ellipsize — under pressure the stage machine flips them
   straight from full text to the icon-only circles below. The leading inset
   matches the collapsed circle's centered icon ((control-size − icon) / 2 =
   --space-2), so the glyph sits at the same x in both states. */
.perm-pill,
.swarm-chip {
  flex: none;
  padding-left: var(--space-2);
}
.swarm-ic,
.swarm-x {
  flex: none;
}

/* Icon-only collapse — stage 1 of the toolbar collapse (see
   measureToolbarCollapse): under pressure the pills flip straight from full
   text to these icon-only circles, and the matching leading inset keeps the
   glyph anchored at the same x across the snap. */
.labels-collapsed .perm-pill {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  justify-content: center;
  flex: none;
}
.labels-collapsed .perm-pill-label { display: none; }
/* Collapsed swarm chip: icon-only circle like the permission pill; hover
   cross-fades the glyph into the dismiss ×, which covers the whole chip. */
.labels-collapsed .swarm-chip {
  position: relative;
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  justify-content: center;
  /* The uncollapsed chip may shrink (label ellipsis); the collapsed circle
     must not — the × fills it inset 0, so a shrunken chip would also shrink
     the dismiss hit area below the control size. */
  flex: none;
}
.labels-collapsed .swarm-label { display: none; }
.labels-collapsed .swarm-ic { transition: opacity var(--duration-base) var(--ease-out); }
.labels-collapsed .swarm-chip:hover .swarm-ic { opacity: 0; }
.labels-collapsed .swarm-x {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  margin-right: 0;
}
/* Touch: no hover morph — the swarm icon stays (it IS the on-state
   indicator) and the dismiss rides as a small corner badge. The chip
   grows to the touch minimum so the dismiss button covering it is a full
   44×44 hit INSIDE toolbar-left's box — an outreaching ::before ring
   would be clipped by its overflow. */
@media (hover: none) {
  .labels-collapsed .swarm-chip {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
  .labels-collapsed .swarm-chip:hover .swarm-ic { opacity: 1; }
  .labels-collapsed .swarm-x {
    inset: 0;
    width: auto;
    height: auto;
    opacity: 1;
    background: transparent;
  }
  /* The visible badge: a dot pinned inside the chip's corner, the close
     glyph centred in it. */
  .labels-collapsed .swarm-x::before {
    inset: auto;
    top: 0;
    right: 0;
    width: var(--p-ic-md);
    height: var(--p-ic-md);
    border-radius: var(--radius-full);
    background: var(--color-selected);
  }
  /* Glyph = badge − --space-1-5 total inset, so size and offset both track
     the badge token and the cross stays centred at any icon scale. */
  .labels-collapsed .swarm-x :deep(svg) {
    position: absolute;
    top: calc(var(--space-1-5) / 2);
    right: calc(var(--space-1-5) / 2);
    width: calc(var(--p-ic-md) - var(--space-1-5));
    height: calc(var(--p-ic-md) - var(--space-1-5));
  }
}

/* Context group — circular ring. Focusable for keyboard / switch access to its
   aria-label and tooltip (see template), so it needs a focus ring. */
.ctx-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 0;
  border-radius: var(--radius-xs);
}
.ctx-group:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* Model pill — shares the toolbar-pill base above; these are its extras:
   shrink-wrap with internal truncation, press scale, and the rotating
   chevron that carries the open state. */
.model-pill {
  gap: var(--space-1);
  line-height: var(--leading-normal);
  overflow: hidden;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 320px;
  transition:
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.model-pill:active {
  transform: scale(0.97);
}
.model-pill:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.model-pill .mp-name {
  /* The pill's only yielding part: the name absorbs the whole deficit (the
     thinking suffix stays rigid, the chevron never shrinks), and once it is
     measured crushed below readability the pill snaps to the bare icon. */
  flex: 0 8 auto;
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.model-pill .think-suffix {
  color: var(--color-accent);
  font-weight: var(--weight-medium);
  /* Never ellipsized — the effort labels are all ≤4 letters, so the suffix
     shows in full or not at all: it stays rigid while the name yields, and
     the pill snaps to the bare icon before the crush could ever reach it. */
  flex: none;
}
.model-pill .cv {
  color: var(--faint);
  flex: none;
  transition:
    transform var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.model-pill:hover .cv,
.model-pill.open .cv {
  color: var(--dim);
}
.model-pill.open .cv {
  transform: rotate(180deg);
}

/* Model pill icon-only collapse — the toolbar's final yield stage (see
   modelPillCollapsed): with the name measured truncated below readability the
   pill sheds its text and chevron for the bare model icon, a fixed 32px
   circle like the collapsed permission pill; the dropdown stays one tap away
   and the tooltip carries the model + effort identity. */
.model-pill.icon-only {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  justify-content: center;
  flex: none;
}

/* Sign-in entry (no models) — same pill shape, accent text to read as an
   action rather than a disabled placeholder. It yields exactly like the
   model pill it stands in for: the name crushes under pressure (the
   collapse machine's valve), then the pill sheds to its bare icon. */
.model-pill.login-pill {
  color: var(--color-accent);
}
.model-pill.login-pill .mp-name {
  color: var(--color-accent);
}

/* Model dropdown — runtime positioning aligns it to the trigger pill. */
.model-dropdown {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  right: calc(var(--composer-control-inset) + var(--composer-send-size) + var(--space-1));
  z-index: var(--z-dropdown);
  min-width: 200px;
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-family: var(--font-ui);
  transform-origin: bottom right;
  /* Last-resort scroll: when the viewport cap leaves less room than the
     pinned controls (thinking / note / more), the whole menu scrolls —
     normal cases shrink .md-list first and never reach this. */
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Flipped below the toolbar when the menu doesn't fit above it (see
   clampModelMenuToViewport). */
.model-dropdown.flip-down {
  top: calc(100% + var(--space-1));
  bottom: auto;
  transform-origin: top right;
}

/* Match SessionRow context menus: grow from the trigger corner and exit faster. */
.composer-menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.composer-menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.composer-menu-pop-enter-from,
.composer-menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(2px);
}
/* The pop nudge follows the anchoring (§03): the default upward menu grows
   toward the trigger below it; a flipped menu hangs under the toolbar, so
   its nudge inverts. */
.model-dropdown.flip-down.composer-menu-pop-enter-from,
.model-dropdown.flip-down.composer-menu-pop-leave-to {
  transform: scale(0.97) translateY(-2px);
}

/* Model rows live in this capped scroll container; the controls below
   (thinking, cache note, more models) stay pinned outside it. */
.md-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: min(320px, 40vh);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.md-section {
  padding: 4px 9px 2px;
  font-size: var(--text-xs);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: var(--weight-semibold);
}

.md-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  color: var(--color-text);
  padding: 5px 9px;
  /* Concentric with the dropdown frame: --radius-lg − hairline − --space-1
     pad = 7.5px. */
  border-radius: var(--radius-dropdown-row);
  text-align: left;
  transition: background var(--duration-base) var(--ease-out);
}
.md-row:hover { background: var(--color-hover); }
.md-row:hover .md-name { color: var(--color-text-strong); }
.md-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md-row:disabled {
  cursor: default;
  opacity: 0.58;
}
.md-row:disabled:hover { background: none; }
.md-row.is-current { background: var(--color-selected); }
.md-note {
  margin-left: auto;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
}

.md-row-more .md-more-icon {
  color: var(--dim);
}
.md-row-more .md-more-arrow {
  color: var(--faint);
  flex: none;
  transition: color var(--duration-base) var(--ease-out);
}
.md-row-more:hover .md-more-arrow {
  color: var(--dim);
}

.md-check {
  width: 14px;
  flex: none;
  color: var(--color-accent);
  font-weight: 500;
  display: flex;
  justify-content: center;
}

.md-name {
  flex: 1;
  transition: color var(--duration-base) var(--ease-out);
}
.md-provider {
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
  flex: none;
}
.md-star {
  color: var(--star);
  flex: none;
  margin-left: auto;
}

.md-divider {
  height: 1px;
  background: var(--line);
  margin: 3px 0;
}

/* Thinking level segmented control — sits inside the model dropdown. */
.md-thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  /* A row of the dropdown: same concentric radius as .md-row. */
  border-radius: var(--radius-dropdown-row);
}
.md-thinking .md-name {
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  color: var(--color-text);
  flex: none;
}
.md-thinking .md-note {
  margin-left: auto;
}
/* The shared SegmentedControl styles itself; the row only owns its layout. */
.md-thinking .ui-seg {
  margin-left: auto;
}

.md-cache-note {
  /* width:0 + min-width:100% — the note never widens the shrink-to-fit
     dropdown, but always fills its width and wraps there naturally. */
  width: 0;
  min-width: 100%;
  padding: 2px 7px 4px;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
  line-height: 1.4;
}

/* Permission dropdown — runtime positioning aligns it to the trigger pill. */
.perm-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: var(--composer-control-inset);
  z-index: var(--z-dropdown);
  min-width: 220px;
  width: max-content;
  max-width: calc(100vw - var(--space-8));
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  /* Same panel inset as the model dropdown — rows stay concentric with the
     frame (--radius-lg − hairline − --space-1 = 7.5px). */
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: 1px;
  transform-origin: bottom left;
}

.pd-row {
  display: grid;
  grid-template-columns: var(--p-ic-md) var(--composer-menu-desc-width, max-content) var(--p-ic-sm);
  column-gap: 7px;
  row-gap: 2px;
  align-items: start;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 7px;
  border-radius: var(--radius-dropdown-row);
  text-align: left;
}
.pd-row:hover { background: var(--color-hover); }
.pd-row.is-current { background: var(--color-hover); }

.pd-icon {
  grid-column: 1;
  grid-row: 1;
  width: var(--p-ic-md);
  min-height: 1lh;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-tight);
}

.pd-check {
  grid-column: 3;
  grid-row: 1;
  width: var(--p-ic-sm);
  min-height: 1lh;
  color: var(--color-accent);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-tight);
}

.pd-info {
  display: contents;
}

.pd-name {
  grid-column: 2;
  grid-row: 1;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.pd-desc {
  grid-column: 2;
  grid-row: 2;
  width: var(--composer-menu-desc-width, auto);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-caption);
  color: var(--muted);
  line-height: var(--leading-tight);
}

/* ---- Narrow composer toolbar ----------------------------------------------
   Below a wide desktop the chat column can be narrower than the full toolbar
   needs — with the sidebar open on a small window, and on phones. Narrowing
   is handled by the toolbar collapse stage machine (see
   measureToolbarCollapse): the model name is the only yielding element and
   the permission/swarm pills flip to icon circles under real pressure, so the
   row never clips its own content. Mobile (≤640px) runs the same machine —
   the rules below only restyle the composer chrome and pin the work-mode
   pill to the pinned 16px input line. */

/* ---- Mobile composer (prototype): round attach + rounded panel input +
       round blue send with a soft shadow. The .cin container loses its border
       and acts as a flex row; the textarea itself becomes the pill input. ---- */
@media (max-width: 640px) {
  .composer {
    padding:
      9px
      var(--dock-inline-right, max(12px, var(--safe-right)))
      max(24px, var(--safe-bottom))
      var(--dock-inline-left, max(12px, var(--safe-left)));
  }
  .composer-card {
    --composer-control-size: 36px;
    /* The mobile input font size, pinned off the UI font scale so iOS doesn't
       auto-zoom on focus. The .ph font and the work-mode pill's one-line
       geometry both derive from it, so the pill can never drift out of sync
       with the pinned first line. */
    --composer-mobile-input-size: 16px;
    max-width: 100%;
  }
  .input-row {
    gap: 6px;
    min-width: 0;
  }
  /* Send → 36px round. The glyph stays the shared 28px registry icon
     (--composer-send-icon-size) — the earlier ::after text-glyph swap read
     tiny at this size and its `svg { display: none }` also hid the starting
     spinner. */
  .send {
    width: var(--composer-send-size);
    height: var(--composer-send-size);
    min-width: var(--composer-send-size);
    padding: 0;
    border-radius: var(--radius-full);
    font-size: 0;
    align-self: flex-end;
    position: relative;
  }
  /* Stop → 36px round to match the mobile Send sizing, same 28px glyph. */
  .stop {
    width: var(--composer-send-size);
    height: var(--composer-send-size);
    min-width: var(--composer-send-size);
    padding: 0;
    border-radius: var(--radius-full);
    font-size: 0;
    align-self: flex-end;
    position: relative;
  }

  /* Mobile toolbar: every control stays visible — attach / permission /
     context ring / model / send. Under pressure the stage machine above
     flips the permission pill to its icon circle, exactly like a narrow
     desktop window (the MobileSettingsSheet keeps its own permission and
     mode rows as the roomier control surface). The context ring stays at
     every width by design — it is the live context-pressure signal on a
     phone (the exact numbers live in the ring's tooltip). The /compact chip
     stays so compaction is one tap away at ≥80% usage — until the very
     narrowest rows, where the stage machine drops it first (it merely
     duplicates the slash command), then the model pill (its identity and
     picker live in the sheet too). */
  /* The armed work-mode pill shows on mobile too — hiding it left goal/plan
     arming with zero composer feedback. Its height pins to the mobile input
     line box (see --composer-mobile-input-size) instead of
     --content-font-size, which tracks the font scale and would outgrow the
     pinned first line. On touch it takes its own lane (the hover:none rule
     below the mobile block). */
  .ph :deep(.wm-pill) {
    height: calc(var(--composer-mobile-input-size) * 1.5);
    line-height: calc(var(--composer-mobile-input-size) * 1.5);
    padding-right: calc((var(--composer-mobile-input-size) * 1.5 - var(--wm-x-size)) / 2);
  }

  /* Model dropdown on mobile → anchored right with padding */
  .model-dropdown {
    right: calc(var(--composer-control-inset) + var(--composer-send-size) + var(--space-1));
    left: auto;
    min-width: 180px;
    max-width: calc(100vw - 24px);
  }

  /* Bump mobile font sizes +2px; the input pins to the anti-zoom mobile size
     (--composer-mobile-input-size on .composer-card). Height (min 36px / max
     one quarter of the viewport) is inherited from the base .ph rule so the
     box auto-grows the same way on touch and desktop. */
  .ph {
    font-size: var(--composer-mobile-input-size);
  }
  .model-pill,
  .attach-btn {
    font-size: var(--ui-font-size);
  }
  .toolbar {
    gap: 6px;
    min-width: 0;
  }
  .toolbar-left,
  .toolbar-right {
    min-width: 0;
  }
  .model-pill {
    max-width: min(52vw, 220px);
  }
  .model-pill .mp-name {
    max-width: min(40vw, 170px);
  }
  .md-row {
    font-size: var(--ui-font-size);
  }
  .md-section {
    font-size: var(--ui-font-size);
  }
  .md-thinking {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .md-thinking .ui-seg {
    margin-left: 0;
  }
  .pd-name {
    font-size: var(--ui-font-size);
  }
  .pd-desc {
    font-size: var(--text-xs);
  }
}

/* On touch the armed pill takes its own lane above the text (the mobile
   touch lane, adapted to the in-flow pill): the ×'s full 44px hit ring then
   fits inside the pill's own footprint instead of covering editable lines —
   the taller headroom and the lane's bottom margin absorb the ring's
   vertical reach, the widened right padding lands the ring's right edge
   exactly on the pill's edge, and the scrollport grows to hold the whole
   lane. The same recipe covers every width: at the desktop 21px line the
   ring clears the first text line by 0.5px, at the mobile pinned 24px line
   by 2px. Expanded mode's taller min-height has the higher specificity and
   always wins. Placed after the ≤640px block so its display / padding-right
   outrank the mobile inline geometry on touch. */
@media (hover: none) {
  .ph[data-wm='true'] :deep(.ProseMirror) {
    padding-top: var(--space-3);
  }
  .ph :deep(.wm-pill) {
    display: flex;
    width: max-content;
    margin-right: 0;
    margin-bottom: var(--space-3);
    padding-right: calc((var(--touch-target-min) - var(--wm-x-size)) / 2);
  }
  .ph :deep(.wm-x)::before {
    inset: calc((var(--wm-x-size) - var(--touch-target-min)) / 2);
  }
  .ph[data-wm='true'] {
    min-height: calc(36px + var(--space-3));
  }
}

/* Touch: invisible rings grow the round mobile controls' hit area toward the
   44px minimum, glyph and visual size unchanged. */
@media (max-width: 640px) and (hover: none) {
  .send,
  .stop,
  .attach-btn,
  .expand-btn,
  .model-pill {
    position: relative;
  }
  .send::before,
  .stop::before,
  .attach-btn::before,
  .expand-btn::before,
  .model-pill::before {
    content: "";
    position: absolute;
    inset: -6px;
  }
  /* 22px glyph needs the wider ring. */
  .expand-btn::before {
    inset: -11px;
  }
  /* The permission entry meets the 44px touch floor by growing its own box
     (an outreaching ring would be clipped by toolbar-left's overflow, and
     the ::after hover wash simply covers the grown box — touch has no
     hover): 44px tall with its label on, 44×44 as the collapsed icon
     circle. */
  .perm-pill {
    height: var(--touch-target-min);
  }
  .labels-collapsed .perm-pill {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
}

/* NOTE: Composer overrides live in src/style.css (global), NOT here. Scoped
   `.cin` rules did NOT reliably win the cascade against the base `.cin` (the
   input stayed square + mono), so they were moved to the global sheet where they
   apply. */
</style>
