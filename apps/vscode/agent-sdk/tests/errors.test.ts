import { describe, it, expect } from "vitest";
import {
  AgentSdkError,
  TransportError,
  ProtocolError,
  SessionError,
  CliError,
  isAgentSdkError,
  getErrorCode,
  getErrorCategory,
  TransportErrorCodes,
  ProtocolErrorCodes,
  SessionErrorCodes,
  CliErrorCodes,
} from "../errors";

// ============================================================================
// TransportError Tests
// ============================================================================
describe("TransportError", () => {
  it("creates error with code and message", () => {
    const err = new TransportError("SPAWN_FAILED", "Failed to spawn CLI");
    expect(err.code).toBe("SPAWN_FAILED");
    expect(err.message).toBe("Failed to spawn CLI");
    expect(err.category).toBe("transport");
    expect(err.name).toBe("TransportError");
  });

  it("includes cause when provided", () => {
    const cause = new Error("ENOENT");
    const err = new TransportError("CLI_NOT_FOUND", "CLI not found", cause);
    expect(err.cause).toBe(cause);
  });

  it("is instance of AgentSdkError", () => {
    const err = new TransportError("PROCESS_CRASHED", "Process crashed");
    expect(err).toBeInstanceOf(AgentSdkError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ============================================================================
// ProtocolError Tests
// ============================================================================
describe("ProtocolError", () => {
  it("creates error with code and message", () => {
    const err = new ProtocolError("INVALID_JSON", "Failed to parse JSON");
    expect(err.code).toBe("INVALID_JSON");
    expect(err.message).toBe("Failed to parse JSON");
    expect(err.category).toBe("protocol");
  });

  it("includes context when provided", () => {
    const err = new ProtocolError("SCHEMA_MISMATCH", "Invalid schema", { field: "user_input" });
    expect(err.context).toEqual({ field: "user_input" });
  });
});

// ============================================================================
// SessionError Tests
// ============================================================================
describe("SessionError", () => {
  it("creates error with code and message", () => {
    const err = new SessionError("SESSION_CLOSED", "Session is closed");
    expect(err.code).toBe("SESSION_CLOSED");
    expect(err.message).toBe("Session is closed");
    expect(err.category).toBe("session");
  });

  it("handles all session error codes", () => {
    const codes = Object.values(SessionErrorCodes);
    for (const code of codes) {
      const err = new SessionError(code, `Error: ${code}`);
      expect(err.code).toBe(code);
    }
  });
});

// ============================================================================
// CliError Tests
// ============================================================================
describe("CliError", () => {
  it("creates error with code and message", () => {
    const err = new CliError("LLM_NOT_SET", "LLM is not configured");
    expect(err.code).toBe("LLM_NOT_SET");
    expect(err.message).toBe("LLM is not configured");
    expect(err.category).toBe("cli");
  });

  it("includes numeric code when provided", () => {
    const err = new CliError("CHAT_PROVIDER_ERROR", "Provider error", -32003);
    expect(err.numericCode).toBe(-32003);
  });

  describe("fromRpcError", () => {
    it("maps -32000 to AUTH_REQUIRED (ACP authRequired)", () => {
      const err = CliError.fromRpcError(-32000, "Auth required");
      expect(err.code).toBe("AUTH_REQUIRED");
      expect(err.numericCode).toBe(-32000);
    });

    it("maps -32001 to LLM_NOT_SET", () => {
      const err = CliError.fromRpcError(-32001, "LLM not set");
      expect(err.code).toBe("LLM_NOT_SET");
    });

    it("maps -32002 to LLM_NOT_SUPPORTED", () => {
      const err = CliError.fromRpcError(-32002, "LLM not supported");
      expect(err.code).toBe("LLM_NOT_SUPPORTED");
    });

    it("maps -32003 to CHAT_PROVIDER_ERROR", () => {
      const err = CliError.fromRpcError(-32003, "Provider error");
      expect(err.code).toBe("CHAT_PROVIDER_ERROR");
    });

    it("maps -32603 to CONFIG_ERROR", () => {
      const err = CliError.fromRpcError(-32603, "Internal error");
      expect(err.code).toBe("CONFIG_ERROR");
    });

    it("maps unknown code to UNKNOWN", () => {
      const err = CliError.fromRpcError(-99999, "Unknown error");
      expect(err.code).toBe("UNKNOWN");
      expect(err.numericCode).toBe(-99999);
    });
  });
});

// ============================================================================
// Utility Functions Tests
// ============================================================================
describe("isAgentSdkError", () => {
  it("returns true for TransportError", () => {
    expect(isAgentSdkError(new TransportError("SPAWN_FAILED", ""))).toBe(true);
  });

  it("returns true for ProtocolError", () => {
    expect(isAgentSdkError(new ProtocolError("INVALID_JSON", ""))).toBe(true);
  });

  it("returns true for SessionError", () => {
    expect(isAgentSdkError(new SessionError("SESSION_CLOSED", ""))).toBe(true);
  });

  it("returns true for CliError", () => {
    expect(isAgentSdkError(new CliError("UNKNOWN", ""))).toBe(true);
  });

  it("returns false for regular Error", () => {
    expect(isAgentSdkError(new Error("regular error"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isAgentSdkError(null)).toBe(false);
    expect(isAgentSdkError(undefined)).toBe(false);
    expect(isAgentSdkError("string")).toBe(false);
    expect(isAgentSdkError(123)).toBe(false);
    expect(isAgentSdkError({})).toBe(false);
  });
});

describe("getErrorCode", () => {
  it("returns code for AgentSdkError", () => {
    expect(getErrorCode(new TransportError("SPAWN_FAILED", ""))).toBe("SPAWN_FAILED");
    expect(getErrorCode(new CliError("LLM_NOT_SET", ""))).toBe("LLM_NOT_SET");
  });

  it("returns UNKNOWN for regular Error", () => {
    expect(getErrorCode(new Error("oops"))).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for non-error", () => {
    expect(getErrorCode(null)).toBe("UNKNOWN");
    expect(getErrorCode("string")).toBe("UNKNOWN");
  });
});

describe("getErrorCategory", () => {
  it("returns category for AgentSdkError", () => {
    expect(getErrorCategory(new TransportError("SPAWN_FAILED", ""))).toBe("transport");
    expect(getErrorCategory(new ProtocolError("INVALID_JSON", ""))).toBe("protocol");
    expect(getErrorCategory(new SessionError("SESSION_CLOSED", ""))).toBe("session");
    expect(getErrorCategory(new CliError("UNKNOWN", ""))).toBe("cli");
  });

  it("returns unknown for regular Error", () => {
    expect(getErrorCategory(new Error("oops"))).toBe("unknown");
  });

  it("returns unknown for non-error", () => {
    expect(getErrorCategory(null)).toBe("unknown");
  });
});

// ============================================================================
// Error Codes Constants Tests
// ============================================================================
describe("Error code constants", () => {
  it("TransportErrorCodes has expected values", () => {
    expect(TransportErrorCodes.SPAWN_FAILED).toBe("SPAWN_FAILED");
    expect(TransportErrorCodes.STDIN_NOT_WRITABLE).toBe("STDIN_NOT_WRITABLE");
    expect(TransportErrorCodes.PROCESS_CRASHED).toBe("PROCESS_CRASHED");
    expect(TransportErrorCodes.CLI_NOT_FOUND).toBe("CLI_NOT_FOUND");
    expect(TransportErrorCodes.ALREADY_STARTED).toBe("ALREADY_STARTED");
    expect(TransportErrorCodes.HANDSHAKE_TIMEOUT).toBe("HANDSHAKE_TIMEOUT");
  });

  it("ProtocolErrorCodes has expected values", () => {
    expect(ProtocolErrorCodes.INVALID_JSON).toBe("INVALID_JSON");
    expect(ProtocolErrorCodes.SCHEMA_MISMATCH).toBe("SCHEMA_MISMATCH");
    expect(ProtocolErrorCodes.UNKNOWN_EVENT_TYPE).toBe("UNKNOWN_EVENT_TYPE");
    expect(ProtocolErrorCodes.UNKNOWN_REQUEST_TYPE).toBe("UNKNOWN_REQUEST_TYPE");
    expect(ProtocolErrorCodes.REQUEST_TIMEOUT).toBe("REQUEST_TIMEOUT");
    expect(ProtocolErrorCodes.REQUEST_CANCELLED).toBe("REQUEST_CANCELLED");
  });

  it("SessionErrorCodes has expected values", () => {
    expect(SessionErrorCodes.SESSION_CLOSED).toBe("SESSION_CLOSED");
    expect(SessionErrorCodes.SESSION_BUSY).toBe("SESSION_BUSY");
    expect(SessionErrorCodes.TURN_INTERRUPTED).toBe("TURN_INTERRUPTED");
    expect(SessionErrorCodes.APPROVAL_FAILED).toBe("APPROVAL_FAILED");
  });

  it("CliErrorCodes has expected values", () => {
    expect(CliErrorCodes.INVALID_STATE).toBe("INVALID_STATE");
    expect(CliErrorCodes.LLM_NOT_SET).toBe("LLM_NOT_SET");
    expect(CliErrorCodes.LLM_NOT_SUPPORTED).toBe("LLM_NOT_SUPPORTED");
    expect(CliErrorCodes.CHAT_PROVIDER_ERROR).toBe("CHAT_PROVIDER_ERROR");
    expect(CliErrorCodes.UNKNOWN).toBe("UNKNOWN");
  });
});
