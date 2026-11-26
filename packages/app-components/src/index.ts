
export { default as ErrorBoundary } from './ErrorBoundary.vue';
export { default as AppToasts } from './AppToasts.vue';
export * from './composer/browserReferences';
export * from './chat/tool-calls/browserReceipts';
export * from './chat/tool-calls/browserLive';
export { default as FilePreview } from './FilePreview.vue';
export {
  default as FilePreviewPanel,
  type FilePreviewPanelPreview,
  type FilePreviewPanelTree,
} from './FilePreviewPanel.vue';
export { default as FilesPanel } from './FilesPanel.vue';
export { default as FileTree } from './FileTree.vue';
export { default as FileTreeSidebar } from './FileTreeSidebar.vue';
export { default as FileTreeSidebarFrame } from './FileTreeSidebarFrame.vue';
export { default as GlobalLoading } from './GlobalLoading.vue';
export { default as HighlightedCode } from './HighlightedCode.vue';
export { default as KimiCodeWordmark } from './KimiCodeWordmark.vue';
export { default as KimiMascot } from './KimiMascot.vue';
export { default as KimiMascotPeek } from './KimiMascotPeek.vue';
export { default as PinnedSessionList } from './PinnedSessionList.vue';
export { default as ResizeHandle } from './ResizeHandle.vue';
export { default as SessionEmojiPicker } from './SessionEmojiPicker.vue';
export { default as SessionRow } from './SessionRow.vue';
export { default as WorkspaceGroup } from './WorkspaceGroup.vue';
export { default as FilterSelect } from './admin/FilterSelect.vue';
export { default as MultiSelectMenu } from './admin/MultiSelectMenu.vue';
export { default as SessionAdminMenu } from './admin/SessionAdminMenu.vue';
export { default as SessionAdminPagination } from './admin/SessionAdminPagination.vue';
export { default as SessionAdminTable } from './admin/SessionAdminTable.vue';
export { default as SessionAdminView } from './admin/SessionAdminView.vue';
export { default as ActivityNotice } from './chat/ActivityNotice.vue';
export { default as ActivityRun } from './chat/ActivityRun.vue';
export { default as AgentDetailPanel } from './chat/AgentDetailPanel.vue';
export { default as AgentPanel } from './chat/AgentPanel.vue';
export { default as AuthMedia } from './chat/AuthMedia.vue';
export { default as ChatPane } from './chat/ChatPane.vue';
export { default as ConversationToc, type ConversationTocItem } from './chat/ConversationToc.vue';
export { isWideTableLayoutActive, useWideTableToc, WIDE_TABLE_MIN_WIDTH, type WideTableToc } from './chat/useWideTableToc';
export { default as CronNotice } from './chat/CronNotice.vue';
export { default as DiffView } from './chat/DiffView.vue';
export { default as MediaLightbox } from './chat/MediaLightbox.vue';
export { default as FileContextMenuHost } from './chat/FileContextMenuHost.vue';
export {
  openFileContextMenu,
  closeFileContextMenu,
  useFileContextMenuState,
} from './chat/fileContextMenu';
export { default as MediaThumb } from './chat/MediaThumb.vue';
export { default as MessageTime } from './chat/MessageTime.vue';
export { default as NotificationCard } from './chat/NotificationCard.vue';
export { default as OpenInMenu } from './chat/OpenInMenu.vue';
export { default as QuestionCard } from './chat/QuestionCard.vue';
export { default as WorkspaceTrustDialog } from './chat/WorkspaceTrustDialog.vue';
export { default as WorkspaceRecentSessions } from './chat/WorkspaceRecentSessions.vue';
export { default as SelectionActionBubble } from './chat/SelectionActionBubble.vue';
export { default as TableSelectionContextMenu } from './chat/TableSelectionContextMenu.vue';
export { default as SideChatPanel } from './chat/SideChatPanel.vue';
export { default as JumpToBottomPill } from './chat/JumpToBottomPill.vue';
export { default as StatusGlyph } from './chat/StatusGlyph.vue';
export { default as StatusPanel } from './chat/StatusPanel.vue';
export { default as ThinkingBlock } from './chat/ThinkingBlock.vue';
export { default as CompactionPanel } from './chat/CompactionPanel.vue';
export { default as ToolCall } from './chat/ToolCall.vue';
export { default as TurnDiffPanel } from './chat/TurnDiffPanel.vue';
export { default as TurnFilesSummary } from './chat/TurnFilesSummary.vue';
export { default as TurnFold } from './chat/TurnFold.vue';
export { default as WorkingIndicator } from './chat/WorkingIndicator.vue';
export { default as GoalPanel } from './chat/dock/GoalPanel.vue';
export { default as PlanPanel } from './chat/dock/PlanPanel.vue';
export { default as SubagentGrid } from './chat/dock/SubagentGrid.vue';
export { default as TasksPane } from './chat/dock/TasksPane.vue';
export { default as TodoCard } from './chat/dock/TodoCard.vue';
export { default as WorkPanelHead } from './chat/dock/WorkPanelHead.vue';
export { default as WorkPill } from './chat/dock/WorkPill.vue';
export { default as AgentTool } from './chat/tool-calls/AgentTool.vue';
export { default as AskUserTool } from './chat/tool-calls/AskUserTool.vue';
export { default as BashTool } from './chat/tool-calls/BashTool.vue';
export { default as CronTool } from './chat/tool-calls/CronTool.vue';
export { default as EditTool } from './chat/tool-calls/EditTool.vue';
export { default as GenericTool } from './chat/tool-calls/GenericTool.vue';
export { default as GlobTool } from './chat/tool-calls/GlobTool.vue';
export { default as GoalTool } from './chat/tool-calls/GoalTool.vue';
export { default as GrepTool } from './chat/tool-calls/GrepTool.vue';
export { default as MediaTool } from './chat/tool-calls/MediaTool.vue';
export { default as NotifyUserTool } from './chat/tool-calls/NotifyUserTool.vue';
export { default as OutputPanel } from './chat/tool-calls/OutputPanel.vue';
export { default as PlanTool } from './chat/tool-calls/PlanTool.vue';
export { default as ReadTool } from './chat/tool-calls/ReadTool.vue';
export { default as SelectToolsTool } from './chat/tool-calls/SelectToolsTool.vue';
export { default as SwarmTool } from './chat/tool-calls/SwarmTool.vue';
export { default as TodoTool } from './chat/tool-calls/TodoTool.vue';
export { default as ToolDisclosure } from './chat/tool-calls/ToolDisclosure.vue';
export { default as WaitForTool } from './chat/tool-calls/WaitForTool.vue';
export { default as WebFetchTool } from './chat/tool-calls/WebFetchTool.vue';
export {
  default as Composer,
  type ComposerCommandPayload,
  type ComposerEmits,
  type ComposerSteerPayload,
  type ComposerSubmitPayload,
} from './composer/Composer.vue';
export { default as ContextComposition } from './composer/ContextComposition.vue';
export { default as ContextSummaryBody } from './composer/ContextSummaryBody.vue';
export { default as MentionMenu } from './composer/MentionMenu.vue';
export { default as SlashMenu } from './composer/SlashMenu.vue';
export { default as AddWorkspaceDialog } from './dialogs/AddWorkspaceDialog.vue';
export { default as BottomSheet } from './dialogs/BottomSheet.vue';
export { default as ConfirmDialog } from './dialogs/ConfirmDialog.vue';
export { default as ConfirmDialogHost } from './dialogs/ConfirmDialogHost.vue';
export { default as PastedTextDialog } from './dialogs/PastedTextDialog.vue';
export { openPastedTextDialog, usePastedTextStats } from './dialogs/pastedTextDialog';
export { default as ModelSwitchConfirmDialog } from './dialogs/ModelSwitchConfirmDialog.vue';
export { default as SearchSessionsDialog } from './dialogs/SearchSessionsDialog.vue';
export { default as WorkspaceEditDialog } from './dialogs/WorkspaceEditDialog.vue';
export { default as MobileTopBar } from './mobile/MobileTopBar.vue';
export { default as AddProviderPage } from './settings/AddProviderPage.vue';
export { default as BrowserTabTitleSetting } from './settings/BrowserTabTitleSetting.vue';
export { default as FontSettingsPage } from './settings/FontSettingsPage.vue';
export { default as FontSettingsRow } from './settings/FontSettingsRow.vue';
export { default as GlobalAgentsMdSetting } from './settings/GlobalAgentsMdSetting.vue';
export { default as SettingsSubpage } from './settings/SettingsSubpage.vue';
export {
  SettingsSubpageHostKey,
  useSettingsSubpage,
  type SettingsSubpage as SettingsSubpageState,
  type SettingsSubpageHost,
} from './settings/useSettingsSubpage';
export {
  FontPreviewBrandKey,
  fontPreviewChrome,
  type FontPreviewChrome,
  type FontPreviewPlatform,
} from './settings/fontPreviewChrome';
export { default as ManagedProviderView } from './settings/ManagedProviderView.vue';
export { ComposerNativeMenuHostKey, NativeMenuHostKey } from './composer/nativeMenus';
export { default as ModelPicker } from './settings/ModelPicker.vue';
export { default as PlanUpgradeCard } from './settings/PlanUpgradeCard.vue';
export { default as ProviderBrandIcon } from './settings/ProviderBrandIcon.vue';
export { default as ProviderForm } from './settings/ProviderForm.vue';
export { default as ProvidersPanel } from './settings/ProvidersPanel.vue';
export { default as PluginsPanel } from './settings/PluginsPanel.vue';
export { default as HostsPanel } from './settings/HostsPanel.vue';
export { default as DefaultToolsPanel } from './settings/DefaultToolsPanel.vue';
export { default as DefaultToolsRow } from './settings/DefaultToolsRow.vue';
export { default as DefaultToolsSetting } from './settings/DefaultToolsSetting.vue';
export { default as SecondaryModelPicker } from './settings/SecondaryModelPicker.vue';

export * from './chatTurnRendering';
export * from './chat/tool-calls/toolArgs';
export * from './chat/turnFilePathIndex';
export * from './chat/tool-calls/askUserToolParse';
export * from './chat/tool-calls/toolRegistry';
export * from './admin/pageItems';
export * from './admin/formatAdminTime';
export { planAdminBatchToast, undoBatchDirectionOf } from '@moonshot-ai/app-client/client';
export type { AdminBatchToastPlan, SessionAdminBatchDirection } from '@moonshot-ai/app-client/client';
export * from './admin/useSessionAdminBatch';
export * from './composables/useAnchoredMenu';
export * from './lib/toolMeta';
export * from './lib/activitySummary';
export * from './lib/openInTarget';
export { useDialogFocus } from './composables/useDialogFocus';
export { useFileStaleness, type FileStalenessTracker } from './composables/useFileStaleness';
export { useFileTreePosition, type FileTreePosition } from './composables/useFileTreePosition';
export {
  useSessionDrag,
  usePinnedDropTarget,
  usePinnedListDrag,
  usePinnedReturnTarget,
  useWorkspaceReorder,
  isSessionRowDrag,
  isWorkspaceRowDrag,
  type PinnedDragSession,
} from './composables/useSessionDrag';
export { default as WorkspaceMenu } from './sidebar/WorkspaceMenu.vue';
export { default as SessionListPanel } from './sidebar/SessionListPanel.vue';
export { default as WorkspaceDirectory } from './sidebar/WorkspaceDirectory.vue';
export { default as WorkspaceHoverCard } from './sidebar/WorkspaceHoverCard.vue';
export { useWorkspaceHoverCard } from './sidebar/useWorkspaceHoverCard';
export { default as RcDeviceSwitcher } from './sidebar/RcDeviceSwitcher.vue';
export { useWorkspaceRename } from './sidebar/useWorkspaceRename';

export { browserApprovalPresentation } from './chat/tool-calls/browserToolPresentation';
export { default as PanelContextMenu } from './panel/PanelContextMenu.vue';
export { default as PanelTabLabel } from './panel/PanelTabLabel.vue';
export { default as FontOptionPreview } from './settings/FontOptionPreview.vue';
export { default as FontSettingsPreview } from './settings/FontSettingsPreview.vue';
export { default as InspectorPane } from './panel/InspectorPane.vue';
