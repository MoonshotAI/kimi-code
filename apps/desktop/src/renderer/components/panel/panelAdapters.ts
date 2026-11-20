import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';

import type { Ref } from 'vue';
import type {
  ChatTurn,
  DiffFullTexts,
  DiffViewLine,
  FilePreviewRequest,
} from '@moonshot-ai/app-core/client';
import type { useFilePreview, usePanelTabs } from '@moonshot-ai/app-client/composables';
import type { PanelTab } from '@moonshot-ai/app-client/composables';
import type {
  AgentTabPayload,
  BtwTabPayload,
  CompactionTabPayload,
  DiffTabPayload,
  FileTabPayload,
  TurnDiffTabPayload,
} from '@moonshot-ai/app-client/panel';
import type { PromptAttachment, SideChatTurnError } from '@moonshot-ai/app-client/client';
import type { OpenMediaRequest } from '../../types';
import { isWindowsPath, normalizeRelativePath, pathRelativeTo, resolveLocalPath } from '@moonshot-ai/app-core/lib';
import { useWorkspaceTrust } from '@moonshot-ai/app-client/composables';
import { filesStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { focusAfterTabClose } from './tabCloseFocus';

export interface PanelAdapterClient {
  activeSessionId: Ref<string | null>;
  activeWorkspaceId: Ref<string | null>;
  status: Ref<{ cwd: string }>;
  turns: Ref<ChatTurn[]>;
  changes: Ref<{ path: string; status: string }[]>;
  gitInfo: Ref<{ branch: string; ahead: number; behind: number } | null>;
  fileDiff: Ref<DiffViewLine[]>;
  fileDiffTexts: Ref<DiffFullTexts | null>;
  fileDiffEmptyFile: Ref<boolean>;
  selectedDiffPath: Ref<string | null>;
  fileDiffLoading: Ref<boolean>;
  fileDiffLoadedSeq: Ref<number>;
  fileDiffLoadStartedSeq: Ref<number>;
  fileDiffRefreshing: Ref<boolean>;
  clearFileDiff: () => void;
  loadFileDiff: (path: string, opts?: { preserveCurrent?: boolean; root?: string }) => Promise<void>;
  sideChatTurnsOf: (agentId: string) => ChatTurn[];
  sideChatSendingOf: (agentId: string) => boolean;
  sideChatRunningOf: (agentId: string) => boolean;
  sideChatTurnErrorOf: (agentId: string) => SideChatTurnError | null;
  sendSideChatPromptOn: (parent: string, agentId: string, text: string | { text: string; attachments?: PromptAttachment[]; snapshot?: ComposerDocumentSnapshot }, opts?: { attachments?: PromptAttachment[] }) => Promise<boolean>;
  cancelSideChatOn?: (parent: string, agentId: string) => Promise<boolean>;
}

export interface PanelAdapterCtx {
  panel: ReturnType<typeof usePanelTabs>;
  client: PanelAdapterClient;
  filePreview: ReturnType<typeof useFilePreview>;
  previewStale: Ref<boolean>;
  diffStale: Ref<boolean>;
  onOpenMedia: (payload: OpenMediaRequest) => void;
  openFile: (target: FilePreviewRequest) => void;
}

export function panelTabProps(tab: PanelTab, ctx: PanelAdapterCtx): Record<string, unknown> | null {
  const { panel, client, filePreview } = ctx;
  const closeThis = () => {
    panel.closeTab(tab.id);
    focusAfterTabClose();
  };

  const toTreePath = (p: string): string => {
    const windows = isWindowsPath(p) || isWindowsPath(client.status.value.cwd);
    const isAbsolute = p.startsWith('/') || p.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(p);
    const fold = (s: string): string => (windows ? s.toLowerCase() : s);
    const unified = fold(normalizeRelativePath(p));
    if (!isAbsolute) return unified;
    const base = fold(normalizeRelativePath(client.status.value.cwd));
    if (base === '') return unified;
    return pathRelativeTo(unified, base) ?? `/${unified}`;
  };

  switch (tab.type) {
    case 'file': {
      const payload = tab.payload as FileTabPayload;
      const sessionId = client.activeSessionId.value;
      const workspaceId = client.activeWorkspaceId.value;
      const workspace = workspaceId === null
        ? undefined
        : workspacesStore().mergedWorkspaces.find((item) => item.id === workspaceId);
      const roots = workspace === undefined ? [] : [workspace.root, ...workspace.additionalDirs];
      const root = filesStore().resolveFileTreeRoot(workspaceId, roots, client.status.value.cwd);
      return {
        preview: {
          file: filePreview.previewFile.value,
          loading: filePreview.previewLoading.value,
          error: filePreview.previewError.value,
          line: payload.line,
          downloadUrl: filePreview.previewDownloadUrl.value,
          mediaUrl: filePreview.previewMediaUrl.value,
          displayPath: filePreview.previewAbsolutePath.value ?? undefined,
          closable: true,
          externalActions: filePreview.previewExternalActions.value,
          assumed: filePreview.previewTarget.value?.assumed === true,
          stale: ctx.previewStale.value,
          refreshing: filePreview.previewRefreshing.value,
          openFile: ctx.openFile,
          onClose: closeThis,
          onOpenExternal: () => filePreview.openPreviewInEditor(),
          onReveal: () => filePreview.revealPreviewFile(),
          onRefresh: () => filePreview.refreshFilePreview(),
        },
        tree: {
          available: sessionId !== null,
          sessionId,
          roots,
          root,
          cwd: client.status.value.cwd,
          selectedPath: filePreview.previewNormalizedPath.value,
          onSelectRoot: (nextRoot: string) =>
            filesStore().selectFileTreeRoot(workspaceId, roots, nextRoot, client.status.value.cwd),
          onSelectFile: (path: string) => {
            const existing = panel.panelTabs.value.find(
              (candidate) =>
                candidate.type === 'file' &&
                candidate.id !== tab.id &&
                (candidate.payload as FileTabPayload | undefined)?.path !== undefined &&
                toTreePath((candidate.payload as FileTabPayload).path) === toTreePath(path),
            );
            if (existing !== undefined) {
              panel.activateTab(existing.id);
              return;
            }
            panel.updateTabPayload(tab.id, { path } satisfies FileTabPayload);
          },
        },
      };
    }
    case 'files':
      return {};
    case 'diff': {
      const root = (tab.payload as DiffTabPayload | undefined)?.root;
      const sessionId = client.activeSessionId.value;
      const workspaceId = client.activeWorkspaceId.value;
      const workspace = workspaceId === null
        ? undefined
        : workspacesStore().mergedWorkspaces.find((item) => item.id === workspaceId);
      const roots = workspace === undefined ? [client.status.value.cwd] : [workspace.root, ...workspace.additionalDirs];
      const status = root === undefined || sessionId === null ? undefined : filesStore().gitStatusForRoot(sessionId, root);
      const changes = root === undefined
        ? client.changes.value
        : Object.entries(status?.entries ?? {}).map(([path, state]) => ({ path, status: state })).sort((a, b) => a.path.localeCompare(b.path));
      const gitInfo = root === undefined
        ? client.gitInfo.value
        : status === undefined ? null : { branch: status.branch, ahead: status.ahead, behind: status.behind };
      return {
        mode: panel.detailDiffMode.value,
        changes,
        gitInfo,
        roots,
        fileDiff: client.fileDiff.value,
        fullTexts: client.fileDiffTexts.value,
        emptyFile: client.fileDiffEmptyFile.value,
        selectedDiffPath: client.selectedDiffPath.value,
        fileDiffLoading: client.fileDiffLoading.value,
        stale: ctx.diffStale.value,
        refreshing: client.fileDiffRefreshing.value,
        cwd: root ?? client.status.value.cwd,
        onSelectRoot: (nextRoot: string) => panel.openDiffDetail(nextRoot),
        onOpen: (path: string) => void panel.selectDiffFile(path, root),
        onOpenFile: (path: string) => panel.openFilePreview({ path: root === undefined ? path : resolveLocalPath(root, path) }),
        onBack: () => {
          panel.detailDiffMode.value = 'list';
          panel.detailDiffPath.value = null;
          client.clearFileDiff();
        },
        onRefresh: () => {
          const path = client.selectedDiffPath.value;
          if (path) void client.loadFileDiff(path, root === undefined ? { preserveCurrent: true } : { preserveCurrent: true, root });
        },
      };
    }
    case 'turn-diff': {
      const payload = tab.payload as TurnDiffTabPayload;
      return {
        change: payload.change,
        daemonTurnId: payload.daemonTurnId,
        sessionId: payload.sessionId,
        cwd: payload.cwd ?? client.status.value.cwd,
        onOpenFile: (path: string) => panel.openFilePreview({ path }),
      };
    }
    case 'compaction': {
      const payload = tab.payload as CompactionTabPayload;
      const text = panel.compactionPanelTextOf(payload.turnId);
      return { text };
    }
    case 'agent': {
      const payload = tab.payload as AgentTabPayload;
      return {
        member: panel.agentPanelMemberOf(payload),
        turns: panel.agentPanelTurnsOf(payload),
        running: panel.agentPanelRunningOf(payload),
        loading: panel.agentPanelLoadingOf(payload),
        loadError: panel.agentPanelLoadErrorOf(payload),
        hasMore: panel.agentPanelHasMoreOf(payload),
        loadingMore: panel.agentPanelLoadingMoreOf(payload),
        loadMoreError: panel.agentPanelLoadMoreErrorOf(payload),
        cwd: client.status.value.cwd,
        onClose: closeThis,
        onLoadOlderMessages: () => panel.loadOlderAgentMessages(payload),
        onOpenMedia: ctx.onOpenMedia,
      };
    }
    case 'btw': {
      const payload = tab.payload as BtwTabPayload;
      const running = client.sideChatRunningOf(payload.agentId);
      const sending = client.sideChatSendingOf(payload.agentId);
      const turnError = client.sideChatTurnErrorOf(payload.agentId);
      return {
        turns: client.sideChatTurnsOf(payload.agentId),
        running,
        sending,
        turnFailed: turnError !== null && !running && !sending,
        turnError,
        agentId: payload.agentId,
        cwd: client.status.value.cwd,
        onSend: (text: string, attachments?: PromptAttachment[], snapshot?: ComposerDocumentSnapshot) => {
          if (!useWorkspaceTrust().gateSubmitForTrust()) return Promise.resolve(false);
          return client.sendSideChatPromptOn(payload.parentId, payload.agentId, { text, attachments, snapshot });
        },
        onInterrupt: () => client.cancelSideChatOn?.(payload.parentId, payload.agentId),
        onOpenMedia: ctx.onOpenMedia,
      };
    }
    case 'inspector':
      return {};
    case 'context':
      return { sessionId: client.activeSessionId.value ?? '' };
    default:
      return null;
  }
}
