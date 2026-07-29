// apps/web/src/composables/useDetailPanel.ts
// Unified right-side detail layer. Only one detail is open at a time.

import { computed, ref, watch, type Ref } from 'vue';
import type { AgentMember } from '../types';
import type { TurnFileChange } from '../components/chatTurnRendering';
import type { DetailTarget } from './useFilePreview';
import type { useKimiWebClient } from './useKimiWebClient';
import { toAgentMember } from './messagesToTurns';
import { auxiliaryTranscriptToTurns } from '../lib/auxiliaryTranscriptToTurns';
import { clampPanelWidth, panelMaxWidth, useViewportWidth } from './useViewportWidth';

type KimiWebClient = ReturnType<typeof useKimiWebClient>;

const PREVIEW_WIDTH_KEY = 'kimi-web.file-preview-width';
export const PREVIEW_MIN = 320;

export interface UseDetailPanelOptions {
  client: KimiWebClient;
  /** Mirrored sidebar width (px) so the preview max-width stays within the viewport. */
  sideWidth: Ref<number>;
  /** Shared owner of the single right-side slot (also written by useFilePreview). */
  detailTarget: Ref<DetailTarget | null>;
  /** Closes the file preview; injected to avoid a composable-to-composable import cycle. */
  closeFilePreview: () => void;
}

export function useDetailPanel({
  client,
  sideWidth,
  detailTarget,
  closeFilePreview,
}: UseDetailPanelOptions) {
  // ---------------------------------------------------------------------------
  // Panel width helpers
  // ---------------------------------------------------------------------------
  const { viewportWidth } = useViewportWidth();

  // Area available to the right of the sidebar (conversation + preview).
  const previewAreaWidth = computed(() =>
    Math.max(0, viewportWidth.value - sideWidth.value),
  );

  // Largest preview width that still leaves the conversation pane usable.
  const previewMax = computed(() =>
    panelMaxWidth(previewAreaWidth.value, PREVIEW_MIN, PREVIEW_MIN),
  );

  function clampPreviewWidth(width: number): number {
    return clampPanelWidth(Math.round(width), PREVIEW_MIN, previewMax.value);
  }

  function defaultPreviewWidth(): number {
    return clampPreviewWidth(previewAreaWidth.value / 2);
  }

  const previewDefaultWidth = computed(() => defaultPreviewWidth());
  const previewWidth = ref(previewDefaultWidth.value);
  // Rendered width, clamped to the current cap so a restored width or a window
  // shrink can never push the resize handle off-screen.
  const previewPanelWidth = computed(() =>
    clampPanelWidth(previewWidth.value, PREVIEW_MIN, previewMax.value),
  );

  // ---------------------------------------------------------------------------
  // Compaction summary panel
  // ---------------------------------------------------------------------------
  const compactionTarget = ref<{ turnId: string } | null>(null);

  const compactionPanelText = computed<string | null>(() => {
    const target = compactionTarget.value;
    if (!target) return null;
    const turn = client.turns.value.find((tn) => tn.id === target.turnId);
    return turn?.role === 'compaction' && turn.text ? turn.text : null;
  });

  const compactionPanelVisible = computed(() => compactionPanelText.value !== null);

  function openCompactionPanel(target: { turnId: string }): void {
    if (compactionTarget.value?.turnId === target.turnId) {
      compactionTarget.value = null;
      if (detailTarget.value === 'compaction') detailTarget.value = null;
      return;
    }
    detailTarget.value = 'compaction';
    compactionTarget.value = target;
  }

  function closeCompactionPanel(): void {
    compactionTarget.value = null;
    if (detailTarget.value === 'compaction') detailTarget.value = null;
  }

  // ---------------------------------------------------------------------------
  // Subagent detail panel
  // ---------------------------------------------------------------------------
  // Callers resolve live tool calls before opening; historical Agent/Swarm
  // cards already carry the persisted id needed for a cold transcript read.
  const agentTarget = ref<{ sessionId: string; subagentId: string } | null>(null);

  const agentTranscriptState = computed(() => {
    const target = agentTarget.value;
    if (!target) return { entry: undefined, version: 0 };
    const entry = client.auxiliaryTranscripts.getEntry(target.sessionId, target.subagentId);
    return { entry, version: entry?.version.value ?? 0 };
  });

  function agentToolMetadata(agentId: string): {
    name?: string;
    subagentType?: string;
    status?: 'running' | 'ok' | 'error';
    outputLines?: string[];
  } {
    const tool = client.turns.value
      .flatMap((turn) => turn.tools ?? [])
      .find((item) => item.agentId === agentId);
    if (!tool) return {};
    try {
      const input = JSON.parse(tool.arg) as Record<string, unknown>;
      return {
        name: typeof input['description'] === 'string' ? input['description'] : undefined,
        subagentType:
          typeof input['subagent_type'] === 'string' ? input['subagent_type'] : undefined,
        status: tool.status,
        outputLines: tool.output,
      };
    } catch {
      return {};
    }
  }

  const agentPanelMember = computed<AgentMember | null>(() => {
    const target = agentTarget.value;
    if (!target) return null;
    const task = client.activeAppTasks.value.find(
      (tk) => tk.agentId === target.subagentId || tk.id === target.subagentId,
    );
    if (task) return toAgentMember(task);

    const channel = agentTranscriptState.value.entry?.channel;
    const descriptor = channel?.agents.find((agent) => agent.agentId === target.subagentId);
    const failed = channel?.refreshError ?? false;
    const loading = channel === undefined || channel.loading;
    const running = channel?.snapshot.meta.activity === 'turn';
    const toolMetadata = agentToolMetadata(target.subagentId);
    const lastTurn = channel?.snapshot.items.findLast((item) => item.kind === 'turn');
    const cancelled = lastTurn?.kind === 'turn' && lastTurn.state === 'cancelled';
    const terminalFailed =
      (lastTurn?.kind === 'turn' && lastTurn.state === 'failed') ||
      toolMetadata.status === 'error';
    const phase = running
      ? 'working'
      : terminalFailed || cancelled
        ? 'failed'
        : loading
          ? 'queued'
          : failed && toolMetadata.status === undefined
            ? 'failed'
            : 'completed';
    const status = running
      ? 'running'
      : cancelled
        ? 'cancelled'
        : terminalFailed
          ? 'failed'
          : loading
            ? 'running'
            : failed && toolMetadata.status === undefined
              ? 'failed'
              : 'completed';
    return {
      id: target.subagentId,
      name: descriptor?.label ?? toolMetadata.name ?? target.subagentId,
      subagentType:
        toolMetadata.subagentType ??
        (descriptor?.type === 'sub' ? 'subagent' : descriptor?.type),
      phase,
      status,
      outputLines: toolMetadata.outputLines,
    };
  });

  const agentPanelTurns = computed(() => {
    const entry = agentTranscriptState.value.entry;
    if (!entry) return [];
    const target = agentTarget.value;
    const descriptor = entry.channel.agents.find(
      (agent) => agent.agentId === target?.subagentId,
    );
    return auxiliaryTranscriptToTurns(
      entry.channel.snapshot,
      client.getFileUrl,
      descriptor,
    );
  });
  const agentPanelLoading = computed(
    () => agentTranscriptState.value.entry?.channel.loading ?? false,
  );
  const agentPanelLoadError = computed(
    () => agentTranscriptState.value.entry?.channel.refreshError ?? false,
  );
  const agentPanelLoadingMore = computed(
    () => agentTranscriptState.value.entry?.channel.loadingOlder ?? false,
  );
  const agentPanelLoadMoreError = computed(
    () => agentTranscriptState.value.entry?.channel.loadOlderError ?? false,
  );
  const agentPanelHasMore = computed(
    () => agentTranscriptState.value.entry?.channel.snapshot.hasMoreOlder ?? false,
  );
  const agentPanelRunning = computed(
    () => agentTranscriptState.value.entry?.channel.snapshot.meta.activity === 'turn',
  );

  const agentPanelVisible = computed(() => agentPanelMember.value !== null);

  function openAgentPanel(target: string): void {
    const sessionId = client.activeSessionId.value;
    if (!target || !sessionId) return;
    if (
      detailTarget.value === 'agent' &&
      agentTarget.value?.sessionId === sessionId &&
      agentTarget.value.subagentId === target
    ) {
      closeAgentPanel();
      return;
    }
    agentTarget.value = { sessionId, subagentId: target };
    detailTarget.value = 'agent';
    client.auxiliaryTranscripts.activate(sessionId, target);
  }

  function closeAgentPanel(): void {
    const target = agentTarget.value;
    if (target) {
      client.auxiliaryTranscripts.deactivate(target.sessionId, target.subagentId);
    }
    agentTarget.value = null;
    if (detailTarget.value === 'agent') detailTarget.value = null;
  }

  watch(detailTarget, (current, previous) => {
    if (previous !== 'agent' || current === 'agent') return;
    const target = agentTarget.value;
    if (target) {
      client.auxiliaryTranscripts.deactivate(target.sessionId, target.subagentId);
    }
  });

  function loadOlderAgentMessages(): void {
    const entry = agentTranscriptState.value.entry;
    if (entry) void entry.channel.loadOlder().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Diff detail layer (opened from the chat header git area)
  // ---------------------------------------------------------------------------
  const detailDiffMode = ref<'list' | 'detail'>('list');
  const detailDiffPath = ref<string | null>(null);

  function openDiffDetail(): void {
    if (detailTarget.value === 'diff') {
      closeDiffDetail();
      return;
    }
    detailTarget.value = 'diff';
    detailDiffMode.value = 'list';
    detailDiffPath.value = null;
    void client.loadGitStatus(client.activeSessionId.value!);
  }

  function closeDiffDetail(): void {
    if (detailTarget.value === 'diff') detailTarget.value = null;
    detailDiffMode.value = 'list';
    detailDiffPath.value = null;
    client.clearFileDiff();
  }

  async function selectDiffFile(path: string): Promise<void> {
    detailDiffMode.value = 'detail';
    detailDiffPath.value = path;
    await client.loadFileDiff(path);
  }

  // ---------------------------------------------------------------------------
  // Turn file-diff detail (opened from a turn's file-change summary card)
  // ---------------------------------------------------------------------------
  // Unlike the git 'diff' slot (workspace vs HEAD), this shows ONE turn's edit to
  // ONE file — the DiffViewLine[] the summary derived alongside its stats.
  const turnDiffChange = ref<TurnFileChange | null>(null);

  function openTurnDiff(change: TurnFileChange): void {
    // Toggle only on the SAME change object: two turns may touch one path, and
    // their TurnFileChange entries are distinct objects — comparing paths would
    // read the second turn's tap as a toggle-off instead of a switch. And only
    // while the turn-diff panel is the active target: after the user moved on
    // to the file preview (header "open file", or a U row opening the file), the
    // stale ref must not turn the next tap into a no-op close.
    if (turnDiffChange.value === change && detailTarget.value === 'turn-diff') {
      closeTurnDiff();
      return;
    }
    turnDiffChange.value = change;
    detailTarget.value = 'turn-diff';
  }

  function closeTurnDiff(): void {
    turnDiffChange.value = null;
    if (detailTarget.value === 'turn-diff') detailTarget.value = null;
  }

  // ---------------------------------------------------------------------------
  // Side chat (BTW) — now rendered in the unified right-side detail layer.
  // ---------------------------------------------------------------------------
  async function openSideChatTab(prompt?: string): Promise<string | null> {
    // Empty-composer heal: `/btw [<question>]` from the new-session screen needs
    // a parent session before openSideChat can start a BTW sub-agent. Create one
    // in the active workspace (same path as the first prompt / a new-session
    // skill / goal), then open the side chat on it. Returns the created session
    // id (null when a session already existed) for follow-up state anchoring.
    if (!client.activeSessionId.value && client.activeWorkspaceId.value) {
      const createdId = await client.startSessionAndOpenSideChat(
        client.activeWorkspaceId.value,
        prompt,
      );
      detailTarget.value = 'btw';
      return createdId;
    }
    await client.openSideChat(prompt);
    detailTarget.value = 'btw';
    return null;
  }

  function closeSideChat(): void {
    client.closeSideChat();
    if (detailTarget.value === 'btw') detailTarget.value = null;
  }

  // Only hides the right-side BTW panel; the side-chat target is per-session and
  // preserved so switching back to a session restores its BTW transcript.
  function hideSideChatPanel(): void {
    if (detailTarget.value === 'btw') detailTarget.value = null;
  }

  const btwVisible = computed(() => client.sideChatVisible.value);

  /** Any occupant of the shared right-side slot. */
  const sidePanelVisible = computed(
    () =>
      detailTarget.value !== null &&
      (detailTarget.value !== 'compaction' || compactionPanelVisible.value) &&
      (detailTarget.value !== 'agent' || agentPanelVisible.value) &&
      (detailTarget.value !== 'btw' || btwVisible.value),
  );

  /** True while the panel's resize handle is being dragged — the width
      transition is disabled so the panel follows the pointer 1:1. */
  const panelDragging = ref(false);

  // ---------------------------------------------------------------------------
  // Per-session panel snapshot (in-memory only). Switching sessions still closes
  // the right-side detail layer, but for the transient panels whose content is
  // re-derived from the session's turns (compaction / agent) or already stored
  // per session (btw), we remember which one was open and restore it when the
  // user switches back.
  //
  // File preview ('file') and git diff ('diff') are intentionally excluded:
  // their content is tied to the active session's cwd / git state and is
  // re-fetched on demand, so restoring them across sessions would be ambiguous.
  // ---------------------------------------------------------------------------
  type PanelSnapshot =
    | { kind: 'compaction'; turnId: string }
    | { kind: 'agent'; subagentId: string }
    | { kind: 'btw' };

  const snapshotBySession = ref<Record<string, PanelSnapshot>>({});

  function captureSnapshot(): PanelSnapshot | null {
    switch (detailTarget.value) {
      case 'compaction':
        return compactionTarget.value ? { kind: 'compaction', ...compactionTarget.value } : null;
      case 'agent':
        return agentTarget.value ? { kind: 'agent', ...agentTarget.value } : null;
      case 'btw':
        return { kind: 'btw' };
      default:
        return null;
    }
  }

  function restoreSnapshot(snap: PanelSnapshot | undefined): void {
    if (!snap) return;
    switch (snap.kind) {
      case 'compaction':
        compactionTarget.value = { turnId: snap.turnId };
        detailTarget.value = 'compaction';
        break;
      case 'agent':
        if (client.activeSessionId.value) {
          agentTarget.value = {
            sessionId: client.activeSessionId.value,
            subagentId: snap.subagentId,
          };
          detailTarget.value = 'agent';
          client.auxiliaryTranscripts.activate(
            client.activeSessionId.value,
            snap.subagentId,
          );
        }
        break;
      case 'btw':
        // Only re-open the BTW panel if this session still has a live side chat;
        // the snapshot can outlive it if the user closed the side chat explicitly.
        if (client.sideChatVisible.value) detailTarget.value = 'btw';
        break;
    }
  }

  // Escape closes whichever transient right-side detail panel is open.
  function closeOpenSidePanel(): boolean {
    if (detailTarget.value === 'compaction' && compactionPanelVisible.value) { closeCompactionPanel(); return true; }
    if (detailTarget.value === 'agent' && agentPanelVisible.value) { closeAgentPanel(); return true; }
    if (detailTarget.value === 'file') { closeFilePreview(); return true; }
    if (detailTarget.value === 'diff') { closeDiffDetail(); return true; }
    if (detailTarget.value === 'turn-diff') { closeTurnDiff(); return true; }
    if (detailTarget.value === 'btw') { closeSideChat(); return true; }
    return false;
  }

  watch(client.activeSessionId, (newId, oldId) => {
    // Remember the leaving session's open panel (restorable kinds only) before
    // the close calls below wipe the target refs.
    if (oldId) {
      const snap = captureSnapshot();
      if (snap) snapshotBySession.value[oldId] = snap;
      else delete snapshotBySession.value[oldId];
    }
    // Close everything for the incoming session (unchanged behavior).
    closeFilePreview();
    closeCompactionPanel();
    closeAgentPanel();
    closeDiffDetail();
    closeTurnDiff();
    hideSideChatPanel();
    // Restore the entering session's panel, if it had one.
    if (newId) {
      restoreSnapshot(snapshotBySession.value[newId]);
    }
  });

  return {
    PREVIEW_WIDTH_KEY,
    PREVIEW_MIN,
    previewDefaultWidth,
    previewMax,
    previewWidth,
    previewPanelWidth,
    compactionPanelText,
    compactionPanelVisible,
    openCompactionPanel,
    closeCompactionPanel,
    agentPanelMember,
    agentPanelTurns,
    agentPanelLoading,
    agentPanelLoadError,
    agentPanelLoadingMore,
    agentPanelLoadMoreError,
    agentPanelHasMore,
    agentPanelRunning,
    agentPanelVisible,
    openAgentPanel,
    closeAgentPanel,
    loadOlderAgentMessages,
    detailDiffMode,
    detailDiffPath,
    openDiffDetail,
    closeDiffDetail,
    selectDiffFile,
    turnDiffChange,
    openTurnDiff,
    closeTurnDiff,
    btwVisible,
    openSideChatTab,
    closeSideChat,
    hideSideChatPanel,
    sidePanelVisible,
    panelDragging,
    closeOpenSidePanel,
  };
}
