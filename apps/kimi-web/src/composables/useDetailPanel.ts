// apps/kimi-web/src/composables/useDetailPanel.ts
// Unified right-side detail layer. Only one detail is open at a time.

import { computed, ref, watch, type Ref } from 'vue';
import type { AgentMember, ToolDiffTarget } from '../types';
import type { DetailTarget } from './useFilePreview';
import type { useKimiWebClient } from './useKimiWebClient';
import { buildEditDiffLines, extractEditPath, findToolCallById } from '../lib/toolDiff';
import { toolLabel } from '../lib/toolMeta';
import { clampPanelWidth, panelMaxWidth, useViewportWidth } from './useViewportWidth';
import { streamingBySession } from './client/streamingStore';

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
  // Thinking panel
  // ---------------------------------------------------------------------------
  const thinkingTarget = ref<{ turnId: string; blockIndex: number; live?: boolean } | null>(null);

  const thinkingPanelText = computed<string | null>(() => {
    const target = thinkingTarget.value;
    if (!target) return null;
    // A live (still-streaming) thinking block is not in `client.turns` — its
    // text lives in the streaming store. Read it there so the panel shows the
    // growing text while the reply is still streaming (reactive: updates on
    // each delta).
    if (target.live) {
      const sid = client.activeSessionId.value;
      const live = streamingBySession[sid]?.blocks.find(
        (b) => b.kind === 'thinking' && b.contentIndex === target.blockIndex,
      );
      if (live?.text) return live.text;
      // The store is cleared at every `messageUpdated` (tool slot / step end /
      // turn end) so the committed content takes over in the chat. The last
      // deltas and that clear land in the same tick and coalesce, so without a
      // fallback the panel would close *before* rendering the final chunk.
      // Fall back to the committed thinking block in the turn — it already
      // holds the full text — so the panel keeps showing the complete content
      // through the boundary instead of flickering closed.
      const turn = client.turns.value.find((tn) => tn.id === target.turnId);
      const committed = turn?.blocks?.find((b) => b.kind === 'thinking');
      return committed?.kind === 'thinking' ? committed.thinking : null;
    }
    const turn = client.turns.value.find((tn) => tn.id === target.turnId);
    const blk = turn?.blocks?.[target.blockIndex];
    return blk?.kind === 'thinking' ? blk.thinking : null;
  });

  const thinkingVisible = computed(() => thinkingPanelText.value !== null);

  function openThinkingPanel(target: { turnId: string; blockIndex: number; live?: boolean }): void {
    const current = thinkingTarget.value;
    if (
      current &&
      current.turnId === target.turnId &&
      current.blockIndex === target.blockIndex &&
      current.live === target.live
    ) {
      thinkingTarget.value = null;
      if (detailTarget.value === 'thinking') detailTarget.value = null;
      return;
    }
    detailTarget.value = 'thinking';
    thinkingTarget.value = target;
  }

  function closeThinkingPanel(): void {
    thinkingTarget.value = null;
    if (detailTarget.value === 'thinking') detailTarget.value = null;
  }

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
  const agentTarget = ref<{ turnId: string; blockIndex: number; memberId: string } | null>(null);

  const agentPanelMember = computed<AgentMember | null>(() => {
    const target = agentTarget.value;
    if (!target) return null;
    const turn = client.turns.value.find((tn) => tn.id === target.turnId);
    const blk = turn?.blocks?.[target.blockIndex];
    if (!blk) return null;
    if (blk.kind === 'agent') return blk.member.id === target.memberId ? blk.member : null;
    if (blk.kind === 'agentGroup') return blk.members.find((m) => m.id === target.memberId) ?? null;
    return null;
  });

  const agentPanelVisible = computed(() => agentPanelMember.value !== null);

  function openAgentPanel(target: { turnId: string; blockIndex: number; memberId: string }): void {
    const current = agentTarget.value;
    if (current && current.turnId === target.turnId && current.memberId === target.memberId) {
      agentTarget.value = null;
      if (detailTarget.value === 'agent') detailTarget.value = null;
      return;
    }
    detailTarget.value = 'agent';
    agentTarget.value = target;
  }

  function closeAgentPanel(): void {
    agentTarget.value = null;
    if (detailTarget.value === 'agent') detailTarget.value = null;
  }

  // ---------------------------------------------------------------------------
  // Edit/Write tool-call diff preview
  // ---------------------------------------------------------------------------
  // Store only the tool id and re-derive the panel payload from the live tool
  // call in the session turns, so a panel opened while the tool is still
  // running keeps tracking its status / output / diff as they update.
  const toolDiffToolId = ref<string | null>(null);

  const toolDiffTarget = computed<ToolDiffTarget | null>(() => {
    const id = toolDiffToolId.value;
    if (!id) return null;
    const tool = findToolCallById(client.turns.value, id);
    if (!tool) return null;
    return {
      id,
      title: toolLabel(tool.name),
      path: extractEditPath(tool.arg),
      // On error the diff describes what was attempted, not what happened —
      // show the tool output (the failure reason) instead.
      lines: tool.status === 'error' ? null : buildEditDiffLines(tool),
      output: tool.output,
    };
  });

  const toolDiffVisible = computed(() => toolDiffTarget.value !== null);

  function openToolDiff(id: string): void {
    if (detailTarget.value === 'toolDiff' && toolDiffToolId.value === id) {
      closeToolDiff();
      return;
    }
    detailTarget.value = 'toolDiff';
    toolDiffToolId.value = id;
  }

  function closeToolDiff(): void {
    toolDiffToolId.value = null;
    if (detailTarget.value === 'toolDiff') detailTarget.value = null;
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
  // Side chat (BTW) — now rendered in the unified right-side detail layer.
  // ---------------------------------------------------------------------------
  async function openSideChatTab(prompt?: string): Promise<void> {
    await client.openSideChat(prompt);
    detailTarget.value = 'btw';
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
      (detailTarget.value !== 'thinking' || thinkingVisible.value) &&
      (detailTarget.value !== 'compaction' || compactionPanelVisible.value) &&
      (detailTarget.value !== 'agent' || agentPanelVisible.value) &&
      (detailTarget.value !== 'toolDiff' || toolDiffVisible.value) &&
      (detailTarget.value !== 'btw' || btwVisible.value),
  );

  /** True while the panel's resize handle is being dragged — the width
      transition is disabled so the panel follows the pointer 1:1. */
  const panelDragging = ref(false);

  // ---------------------------------------------------------------------------
  // Per-session panel snapshot (in-memory only). Switching sessions still closes
  // the right-side detail layer, but for the transient panels whose content is
  // re-derived from the session's turns (thinking / compaction / agent /
  // toolDiff) or already stored per session (btw), we remember which one was
  // open and restore it when the user switches back.
  //
  // File preview ('file') and git diff ('diff') are intentionally excluded:
  // their content is tied to the active session's cwd / git state and is
  // re-fetched on demand, so restoring them across sessions would be ambiguous.
  // ---------------------------------------------------------------------------
  type PanelSnapshot =
    | { kind: 'thinking'; turnId: string; blockIndex: number }
    | { kind: 'compaction'; turnId: string }
    | { kind: 'agent'; turnId: string; blockIndex: number; memberId: string }
    | { kind: 'toolDiff'; toolId: string }
    | { kind: 'btw' };

  const snapshotBySession = ref<Record<string, PanelSnapshot>>({});

  function captureSnapshot(): PanelSnapshot | null {
    switch (detailTarget.value) {
      case 'thinking':
        return thinkingTarget.value ? { kind: 'thinking', ...thinkingTarget.value } : null;
      case 'compaction':
        return compactionTarget.value ? { kind: 'compaction', ...compactionTarget.value } : null;
      case 'agent':
        return agentTarget.value ? { kind: 'agent', ...agentTarget.value } : null;
      case 'toolDiff':
        return toolDiffToolId.value ? { kind: 'toolDiff', toolId: toolDiffToolId.value } : null;
      case 'btw':
        return { kind: 'btw' };
      default:
        return null;
    }
  }

  function restoreSnapshot(snap: PanelSnapshot | undefined): void {
    if (!snap) return;
    switch (snap.kind) {
      case 'thinking':
        thinkingTarget.value = { turnId: snap.turnId, blockIndex: snap.blockIndex };
        detailTarget.value = 'thinking';
        break;
      case 'compaction':
        compactionTarget.value = { turnId: snap.turnId };
        detailTarget.value = 'compaction';
        break;
      case 'agent':
        agentTarget.value = { turnId: snap.turnId, blockIndex: snap.blockIndex, memberId: snap.memberId };
        detailTarget.value = 'agent';
        break;
      case 'toolDiff':
        toolDiffToolId.value = snap.toolId;
        detailTarget.value = 'toolDiff';
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
    if (detailTarget.value === 'thinking' && thinkingVisible.value) { closeThinkingPanel(); return true; }
    if (detailTarget.value === 'compaction' && compactionPanelVisible.value) { closeCompactionPanel(); return true; }
    if (detailTarget.value === 'agent' && agentPanelVisible.value) { closeAgentPanel(); return true; }
    if (detailTarget.value === 'toolDiff' && toolDiffVisible.value) { closeToolDiff(); return true; }
    if (detailTarget.value === 'file') { closeFilePreview(); return true; }
    if (detailTarget.value === 'diff') { closeDiffDetail(); return true; }
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
    closeThinkingPanel();
    closeCompactionPanel();
    closeAgentPanel();
    closeToolDiff();
    closeDiffDetail();
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
    thinkingPanelText,
    thinkingVisible,
    openThinkingPanel,
    closeThinkingPanel,
    compactionPanelText,
    compactionPanelVisible,
    openCompactionPanel,
    closeCompactionPanel,
    agentPanelMember,
    agentPanelVisible,
    openAgentPanel,
    closeAgentPanel,
    toolDiffTarget,
    toolDiffVisible,
    openToolDiff,
    closeToolDiff,
    detailDiffMode,
    detailDiffPath,
    openDiffDetail,
    closeDiffDetail,
    selectDiffFile,
    btwVisible,
    openSideChatTab,
    closeSideChat,
    hideSideChatPanel,
    sidePanelVisible,
    panelDragging,
    closeOpenSidePanel,
  };
}
