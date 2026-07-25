import type { ErrorPhase } from "./types";

// Keep the released Webview's error contract local. The upper-case values are
// accepted for sessions restored from the legacy extension; the dotted values
// are emitted by the in-process v1 core.
const LEGACY = {
  CLI_NOT_FOUND: "CLI_NOT_FOUND",
  SPAWN_FAILED: "SPAWN_FAILED",
  ALREADY_STARTED: "ALREADY_STARTED",
  STDIN_NOT_WRITABLE: "STDIN_NOT_WRITABLE",
  HANDSHAKE_TIMEOUT: "HANDSHAKE_TIMEOUT",
  PROCESS_CRASHED: "PROCESS_CRASHED",
  LLM_NOT_SET: "LLM_NOT_SET",
  LLM_NOT_SUPPORTED: "LLM_NOT_SUPPORTED",
  INVALID_STATE: "INVALID_STATE",
  CHAT_PROVIDER_ERROR: "CHAT_PROVIDER_ERROR",
  SESSION_BUSY: "SESSION_BUSY",
  SESSION_CLOSED: "SESSION_CLOSED",
  TURN_INTERRUPTED: "TURN_INTERRUPTED",
  INVALID_JSON: "INVALID_JSON",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_PARAMS: "INVALID_PARAMS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// Pre-flight: task didn't start at all or was blocked by "gatekeeper"
export const PREFLIGHT_CODES = new Set<string>([
  LEGACY.CLI_NOT_FOUND,
  LEGACY.SPAWN_FAILED,
  LEGACY.ALREADY_STARTED,
  LEGACY.STDIN_NOT_WRITABLE,
  LEGACY.PROCESS_CRASHED,
  LEGACY.LLM_NOT_SET,
  LEGACY.LLM_NOT_SUPPORTED,
  LEGACY.INVALID_STATE,
  LEGACY.SESSION_BUSY,
  "config.invalid",
  "model.not_configured",
  "auth.login_required",
  "session.not_found",
  "session.state_not_found",
  "session.state_invalid",
  "session.init_failed",
  "shell.git_bash_not_found",
]);

// User-friendly error messages
export const ERROR_MESSAGES: Record<string, string> = {
  // Pre-flight
  [LEGACY.CLI_NOT_FOUND]: "Kimi Code CLI not found.",
  [LEGACY.SPAWN_FAILED]: "Failed to start Kimi Code CLI.",
  [LEGACY.ALREADY_STARTED]: "A session is already running.",
  [LEGACY.STDIN_NOT_WRITABLE]: "Failed to communicate with Kimi Code CLI.",
  [LEGACY.HANDSHAKE_TIMEOUT]: "Connection timed out.",
  [LEGACY.PROCESS_CRASHED]: "Process connection lost.",

  // CLI errors
  [LEGACY.LLM_NOT_SET]: "Authentication failed. Please sign in.",
  [LEGACY.LLM_NOT_SUPPORTED]: "This model is not supported.",
  [LEGACY.INVALID_STATE]: "Please wait for the current operation.",
  [LEGACY.CHAT_PROVIDER_ERROR]: "Service temporarily unavailable.",

  // Session errors
  [LEGACY.SESSION_BUSY]: "A message is being sent. Please wait.",
  [LEGACY.SESSION_CLOSED]: "Session was closed.",
  [LEGACY.TURN_INTERRUPTED]: "Stopped by user.",

  // Protocol errors
  [LEGACY.INVALID_JSON]: "Communication format error.",
  [LEGACY.INVALID_REQUEST]: "Invalid request.",
  [LEGACY.INVALID_PARAMS]: "Invalid parameters.",
  [LEGACY.INTERNAL_ERROR]: "Internal error occurred.",

  "config.invalid": "Kimi Code configuration is invalid.",
  "model.not_configured": "No model is configured. Please sign in or configure a provider.",
  "auth.login_required": "Authentication failed. Please sign in.",
  "session.not_found": "Session was not found.",
  "session.state_not_found": "Session data is missing.",
  "session.state_invalid": "Session data is invalid.",
  "session.init_failed": "Failed to initialize the session.",
  "session.closed": "Session was closed.",
  "session.fork_active_turn": "Wait for the current response before forking.",
  "turn.agent_busy": "A message is being sent. Please wait.",
  "provider.api_error": "Service temporarily unavailable.",
  "provider.rate_limit": "Too many requests. Please try again later.",
  "provider.auth_error": "Authentication failed. Please sign in again.",
  "provider.connection_error": "Could not connect to the model provider.",
  "request.prompt_input_empty": "Prompt cannot be empty.",
  internal: "Internal error occurred.",
};

export function classifyError(code: string): ErrorPhase {
  return PREFLIGHT_CODES.has(code) ? "preflight" : "runtime";
}

export function getUserMessage(code: string, fallback?: string): string {
  return ERROR_MESSAGES[code] || fallback || "An unknown error occurred.";
}

export function isPreflightError(code: string): boolean {
  return PREFLIGHT_CODES.has(code);
}

export function isUserInterrupt(code: string): boolean {
  return code === LEGACY.TURN_INTERRUPTED || code === "turn.cancelled";
}
