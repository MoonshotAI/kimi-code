/**
 * Bridge Protocol - Communication between VS Code extension and webview.
 *
 * Architecture:
 * - Webview calls Methods via RPC (request/response)
 * - Extension broadcasts Events to webview (one-way notifications)
 *
 * RPC flow: webview.call(method, params) -> extension.dispatch -> webview.resolve(result)
 * Event flow: extension.broadcast(event, data) -> webview.on(event, handler)
 */

export const Methods = {
  CheckWorkspace: "checkWorkspace",
  CheckCLI: "checkCLI",
  InstallCLI: "installCLI",

  SaveConfig: "saveConfig",
  SetMode: "setMode",
  SetYoloMode: "setYoloMode",
  GetExtensionConfig: "getExtensionConfig",
  OpenSettings: "openSettings",
  ReloadPlugin: "reloadPlugin",
  OpenFolder: "openFolder",
  GetModels: "getModels",

  GetMCPServers: "getMCPServers",

  StreamChat: "streamChat",
  PrewarmSession: "prewarmSession",
  AbortChat: "abortChat",
  SteerChat: "steerChat",
  ResetSession: "resetSession",
  RespondApproval: "respondApproval",

  GetKimiSessions: "getKimiSessions",
  LoadKimiSessionHistory: "loadKimiSessionHistory",
  DeleteKimiSession: "deleteKimiSession",
  GetProjectFiles: "getProjectFiles",
  GetEditorContext: "getEditorContext",
  InsertText: "insertText",
  PickMedia: "pickMedia",
  OpenFile: "openFile",
  CheckFileExists: "checkFileExists",
  CheckFilesExist: "checkFilesExist",
  OpenFileDiff: "openFileDiff",
  TrackFiles: "trackFiles",
  ClearTrackedFiles: "clearTrackedFiles",
  RevertFiles: "revertFiles",
  KeepChanges: "keepChanges",
} as const;

export const Events = {
  ExtensionConfigChanged: "extensionConfigChanged",
  MCPServersChanged: "mcpServersChanged",
  StreamEvent: "streamEvent",
  FocusInput: "focusInput",
  InsertMention: "insertMention",
  NewConversation: "newConversation",
  FileChangesUpdated: "fileChangesUpdated",
  RollbackInput: "rollbackInput",
} as const;
