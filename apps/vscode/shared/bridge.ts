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
  GetInputHistory: "getInputHistory",
  AddInputHistory: "addInputHistory",

  GetSlashCommands: "getSlashCommands",
  CheckLoginStatus: "checkLoginStatus",
  Login: "login",
  Logout: "logout",
  SaveConfig: "saveConfig",
  GetExtensionConfig: "getExtensionConfig",
  OpenSettings: "openSettings",
  OpenFolder: "openFolder",
  GetModels: "getModels",

  GetMCPServers: "getMCPServers",
  AddMCPServer: "addMCPServer",
  UpdateMCPServer: "updateMCPServer",
  RemoveMCPServer: "removeMCPServer",
  AuthMCP: "authMCP",
  ResetAuthMCP: "resetAuthMCP",
  TestMCP: "testMCP",

  StreamChat: "streamChat",
  AbortChat: "abortChat",
  ResetSession: "resetSession",
  SetPlanMode: "setPlanMode",
  SteerChat: "steerChat",
  RespondApproval: "respondApproval",

  GetKimiSessions: "getKimiSessions",
  GetAllKimiSessions: "getAllKimiSessions",
  GetRegisteredWorkDirs: "getRegisteredWorkDirs",
  SetWorkDir: "setWorkDir",
  BrowseWorkDir: "browseWorkDir",
  LoadKimiSessionHistory: "loadKimiSessionHistory",
  DeleteKimiSession: "deleteKimiSession",
  ForkKimiSession: "forkKimiSession",
  GetProjectFiles: "getProjectFiles",
  PickMedia: "pickMedia",
  OpenFile: "openFile",
  CheckFileExists: "checkFileExists",
  CheckFilesExist: "checkFilesExist",
  OpenFileDiff: "openFileDiff",
  TrackFiles: "trackFiles",
  ClearTrackedFiles: "clearTrackedFiles",
  RevertFiles: "revertFiles",
  KeepChanges: "keepChanges",
  GetImageDataUri: "getImageDataUri",
  ShowLogs: "showLogs",
  ReloadWebview: "reloadWebview",
  RespondQuestion: "respondQuestion",
} as const;

export type RpcMethod = (typeof Methods)[keyof typeof Methods];

export interface RpcMessage {
  readonly id: string;
  readonly method: RpcMethod;
  readonly params?: unknown;
}

export interface RpcResult {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

export type RpcMessageValidation =
  | { readonly ok: true; readonly message: RpcMessage }
  | {
      readonly ok: false;
      readonly id: string;
      readonly method: string;
      readonly error: string;
    };

export const Events = {
  ExtensionConfigChanged: "extensionConfigChanged",
  MCPServersChanged: "mcpServersChanged",
  StreamEvent: "streamEvent",
  FocusInput: "focusInput",
  InsertMention: "insertMention",
  NewConversation: "newConversation",
  FileChangesUpdated: "fileChangesUpdated",
  RollbackInput: "rollbackInput",
  LoginUrl: "loginUrl",
} as const;

const rpcMethods = new Set<string>(Object.values(Methods));

/** Validates the untrusted Webview message before any host-side handler runs. */
export function validateRpcMessage(value: unknown): RpcMessageValidation {
  if (!isPlainObject(value)) {
    return invalidMessage("", "<invalid>", "Invalid bridge request: expected a plain object.");
  }

  const id = value["id"];
  if (!Object.hasOwn(value, "id") || typeof id !== "string" || id.trim().length === 0) {
    return invalidMessage("", safeMethod(value["method"]), "Invalid bridge request: id must be a non-empty string.");
  }

  const method = value["method"];
  if (!Object.hasOwn(value, "method") || typeof method !== "string" || method.trim().length === 0) {
    return invalidMessage(id, "<invalid>", "Invalid bridge request: method must be a non-empty string.");
  }
  if (!rpcMethods.has(method)) {
    return invalidMessage(id, method, `Unknown bridge method: ${method}`);
  }
  const params = Object.hasOwn(value, "params") ? value["params"] : undefined;
  if (!validateParams(method as RpcMethod, params)) {
    return invalidMessage(id, method, `Invalid bridge params for method: ${method}`);
  }

  return { ok: true, message: { id, method: method as RpcMethod, params } };
}

function validateParams(method: RpcMethod, params: unknown): boolean {
  switch (method) {
    case Methods.CheckWorkspace:
    case Methods.GetInputHistory:
    case Methods.GetSlashCommands:
    case Methods.CheckLoginStatus:
    case Methods.Login:
    case Methods.Logout:
    case Methods.GetExtensionConfig:
    case Methods.OpenSettings:
    case Methods.OpenFolder:
    case Methods.GetModels:
    case Methods.GetMCPServers:
    case Methods.AbortChat:
    case Methods.ResetSession:
    case Methods.GetKimiSessions:
    case Methods.GetAllKimiSessions:
    case Methods.GetRegisteredWorkDirs:
    case Methods.BrowseWorkDir:
    case Methods.ClearTrackedFiles:
    case Methods.ShowLogs:
    case Methods.ReloadWebview:
      return params === undefined;

    case Methods.AddInputHistory:
      return hasString(params, "text");
    case Methods.SaveConfig:
      return isPlainObject(params)
        && typeof params["model"] === "string"
        && isOptionalType(params["thinking"], "boolean")
        && isOptionalType(params["effort"], "string");
    case Methods.AddMCPServer:
      return isMcpServerConfig(params);
    case Methods.UpdateMCPServer:
      return isMcpUpdate(params);
    case Methods.RemoveMCPServer:
    case Methods.AuthMCP:
    case Methods.ResetAuthMCP:
    case Methods.TestMCP:
      return hasNonEmptyString(params, "name");
    case Methods.StreamChat:
      return isStreamChatParams(params);
    case Methods.RespondApproval:
      return isPlainObject(params)
        && isNonEmptyString(params["requestId"])
        && (params["response"] === "approve"
          || params["response"] === "approve_for_session"
          || params["response"] === "reject");
    case Methods.RespondQuestion:
      return isPlainObject(params)
        && isNonEmptyString(params["rpcRequestId"])
        && isNonEmptyString(params["questionRequestId"])
        && isStringRecord(params["answers"]);
    case Methods.SetPlanMode:
      return hasBoolean(params, "enabled");
    case Methods.SteerChat:
      return isPlainObject(params) && isContent(params["content"]);
    case Methods.GetProjectFiles:
      return params === undefined || (
        isPlainObject(params)
        && isOptionalType(params["query"], "string")
        && isOptionalType(params["directory"], "string")
      );
    case Methods.SetWorkDir:
      return isPlainObject(params) && (params["workDir"] === null || typeof params["workDir"] === "string");
    case Methods.LoadKimiSessionHistory:
      return hasNonEmptyString(params, "kimiSessionId");
    case Methods.DeleteKimiSession:
      return hasNonEmptyString(params, "sessionId");
    case Methods.ForkKimiSession:
      return isPlainObject(params)
        && isNonEmptyString(params["sessionId"])
        && Number.isInteger(params["turnIndex"])
        && (params["turnIndex"] as number) >= 0;
    case Methods.PickMedia:
      return isPlainObject(params)
        && (params["maxCount"] === undefined
          || (Number.isInteger(params["maxCount"]) && (params["maxCount"] as number) >= 0))
        && isOptionalType(params["includeVideo"], "boolean");
    case Methods.OpenFile:
    case Methods.OpenFileDiff:
    case Methods.CheckFileExists:
    case Methods.GetImageDataUri:
      return hasString(params, "filePath");
    case Methods.CheckFilesExist:
    case Methods.TrackFiles:
      return hasStringArray(params, "paths");
    case Methods.RevertFiles:
    case Methods.KeepChanges:
      return isPlainObject(params) && isOptionalType(params["filePath"], "string");
  }
}

function isStreamChatParams(value: unknown): boolean {
  return isPlainObject(value)
    && isContent(value["content"])
    && typeof value["model"] === "string"
    && isOptionalType(value["effort"], "string")
    && isOptionalType(value["thinking"], "boolean")
    && isOptionalType(value["planMode"], "boolean")
    && isOptionalType(value["sessionId"], "string");
}

function isContent(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.every(isContentPart));
}

function isContentPart(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value["type"] !== "string") return false;
  switch (value["type"]) {
    case "text":
      return typeof value["text"] === "string";
    case "think":
      return typeof value["think"] === "string"
        && (value["encrypted"] === undefined
          || value["encrypted"] === null
          || typeof value["encrypted"] === "string");
    case "image_url":
    case "audio_url":
    case "video_url": {
      const media = value[value["type"]];
      return isPlainObject(media)
        && typeof media["url"] === "string"
        && (media["id"] === undefined || media["id"] === null || typeof media["id"] === "string");
    }
    default:
      return false;
  }
}

function isMcpUpdate(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (Object.hasOwn(value, "server")) {
    return isNonEmptyString(value["originalName"]) && isMcpServerConfig(value["server"]);
  }
  return isMcpServerConfig(value);
}

function isMcpServerConfig(value: unknown): boolean {
  return isPlainObject(value)
    && isNonEmptyString(value["name"])
    && (value["transport"] === "stdio" || value["transport"] === "http")
    && isOptionalType(value["url"], "string")
    && isOptionalType(value["command"], "string")
    && (value["args"] === undefined || isStringArray(value["args"]))
    && (value["env"] === undefined || isStringRecord(value["env"]))
    && (value["headers"] === undefined || isStringRecord(value["headers"]))
    && (value["auth"] === undefined || value["auth"] === "oauth")
    && isOptionalType(value["bearerTokenEnvVar"], "string");
}

function hasString(value: unknown, key: string): boolean {
  return isPlainObject(value) && typeof value[key] === "string";
}

function hasNonEmptyString(value: unknown, key: string): boolean {
  return isPlainObject(value) && isNonEmptyString(value[key]);
}

function hasBoolean(value: unknown, key: string): boolean {
  return isPlainObject(value) && typeof value[key] === "boolean";
}

function hasStringArray(value: unknown, key: string): boolean {
  return isPlainObject(value) && isStringArray(value[key]);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): boolean {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function isOptionalType(value: unknown, type: "string" | "boolean"): boolean {
  return value === undefined || typeof value === type;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidMessage(id: string, method: string, error: string): RpcMessageValidation {
  return { ok: false, id, method, error };
}

function safeMethod(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "<invalid>";
}
