// Error Categories
export type ErrorCategory = "transport" | "protocol" | "session" | "cli";

// Error Code Constants
export const TransportErrorCodes = {
  SPAWN_FAILED: "SPAWN_FAILED",
  STDIN_NOT_WRITABLE: "STDIN_NOT_WRITABLE",
  PROCESS_CRASHED: "PROCESS_CRASHED",
  CLI_NOT_FOUND: "CLI_NOT_FOUND",
  ALREADY_STARTED: "ALREADY_STARTED",
  HANDSHAKE_TIMEOUT: "HANDSHAKE_TIMEOUT",
} as const;

export const ProtocolErrorCodes = {
  INVALID_JSON: "INVALID_JSON",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
  UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
  UNKNOWN_REQUEST_TYPE: "UNKNOWN_REQUEST_TYPE",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
} as const;

export const SessionErrorCodes = {
  SESSION_CLOSED: "SESSION_CLOSED",
  SESSION_BUSY: "SESSION_BUSY",
  TURN_INTERRUPTED: "TURN_INTERRUPTED",
  APPROVAL_FAILED: "APPROVAL_FAILED",
} as const;

export const CliErrorCodes = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INVALID_STATE: "INVALID_STATE",
  LLM_NOT_SET: "LLM_NOT_SET",
  LLM_NOT_SUPPORTED: "LLM_NOT_SUPPORTED",
  CHAT_PROVIDER_ERROR: "CHAT_PROVIDER_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  INVALID_PARAMS: "INVALID_PARAMS",
  UNKNOWN: "UNKNOWN",
} as const;

export type TransportErrorCodeType = (typeof TransportErrorCodes)[keyof typeof TransportErrorCodes];
export type ProtocolErrorCodeType = (typeof ProtocolErrorCodes)[keyof typeof ProtocolErrorCodes];
export type SessionErrorCodeType = (typeof SessionErrorCodes)[keyof typeof SessionErrorCodes];
export type CliErrorCodeType = (typeof CliErrorCodes)[keyof typeof CliErrorCodes];

// Base Error
export abstract class AgentSdkError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Transport Errors - Process and I/O level
export class TransportError extends AgentSdkError {
  readonly category = "transport" as const;

  constructor(
    public readonly code: TransportErrorCodeType,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

// Protocol Errors - JSON-RPC and schema level
export class ProtocolError extends AgentSdkError {
  readonly category = "protocol" as const;

  constructor(
    public readonly code: ProtocolErrorCodeType,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, undefined, context);
  }
}

// Session Errors - Session state level
export class SessionError extends AgentSdkError {
  readonly category = "session" as const;

  constructor(
    public readonly code: SessionErrorCodeType,
    message: string,
  ) {
    super(message);
  }
}

// CLI Errors - Business logic level (from CLI responses)
export class CliError extends AgentSdkError {
  readonly category = "cli" as const;

  constructor(
    public readonly code: CliErrorCodeType,
    message: string,
    public readonly numericCode?: number,
  ) {
    super(message);
  }

  static fromRpcError(rpcCode: number, message: string): CliError {
    const codeMap: Record<number, CliErrorCodeType> = {
      // ACP reuses JSON-RPC -32000 for `authRequired` (see kimi-code
      // acp-adapter: RequestError.authRequired()). Under the wire protocol
      // this code meant INVALID_STATE; on ACP it always signals auth.
      [-32000]: CliErrorCodes.AUTH_REQUIRED,
      [-32001]: CliErrorCodes.LLM_NOT_SET,
      [-32002]: CliErrorCodes.LLM_NOT_SUPPORTED,
      [-32003]: CliErrorCodes.CHAT_PROVIDER_ERROR,
      // JSON-RPC standard INVALID_PARAMS; ACP returns this for unknown model aliases etc.
      [-32602]: CliErrorCodes.INVALID_PARAMS,
      // ACP may wrap config/model lookup failures as JSON-RPC Internal error.
      [-32603]: CliErrorCodes.CONFIG_ERROR,
    };
    return new CliError(codeMap[rpcCode] ?? CliErrorCodes.UNKNOWN, message, rpcCode);
  }
}

// Error Utilities
export function isAgentSdkError(err: unknown): err is AgentSdkError {
  return err instanceof AgentSdkError;
}

export function getErrorCode(err: unknown): string {
  if (isAgentSdkError(err)) {
    return err.code;
  }
  return "UNKNOWN";
}

export function getErrorCategory(err: unknown): ErrorCategory | "unknown" {
  if (isAgentSdkError(err)) {
    return err.category;
  }
  return "unknown";
}
