import { describe, it, expect } from "vitest";
import {
  ContentPartSchema,
  TokenUsageSchema,
  DisplayBlockSchema,
  ToolCallSchema,
  ToolCallPartSchema,
  ToolResultSchema,
  TurnBeginSchema,
  StepBeginSchema,
  StatusUpdateSchema,
  ApprovalRequestPayloadSchema,
  ApprovalRequestResolvedSchema,
  ApprovalResponseSchema,
  PlanSchema,
  ConfigOptionUpdateSchema,
  RunResultSchema,
  RpcMessageSchema,
  parseEventPayload,
  parseRequestPayload,
  type ContentPart,
  type DisplayBlock,
  type UnknownBlock,
  type WireEvent,
  DiffBlock,
  TodoBlock,
  CommandBlock,
  BackgroundTaskBlock,
} from "../schema";

// ============================================================================
// ContentPart Tests
// ============================================================================
describe("ContentPartSchema", () => {
  it("parses text part", () => {
    const input = { type: "text", text: "hello" };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("parses think part", () => {
    const input = { type: "think", think: "reasoning...", encrypted: "abc123" };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("parses think part with null encrypted", () => {
    const input = { type: "think", think: "reasoning...", encrypted: null };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses image_url part", () => {
    const input = { type: "image_url", image_url: { url: "data:image/png;base64,..." } };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses image_url part with id", () => {
    const input = { type: "image_url", image_url: { url: "https://example.com/img.png", id: "img-1" } };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect((result.data as ContentPart & { type: "image_url" }).image_url.id).toBe("img-1");
  });

  it("parses audio_url part", () => {
    const input = { type: "audio_url", audio_url: { url: "data:audio/aac;base64,..." } };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses video_url part", () => {
    const input = { type: "video_url", video_url: { url: "data:video/mp4;base64,..." } };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const input = { type: "invalid", data: "foo" };
    const result = ContentPartSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// TokenUsage Tests
// ============================================================================
describe("TokenUsageSchema", () => {
  it("parses valid token usage", () => {
    const input = {
      input_other: 100,
      output: 50,
      input_cache_read: 20,
      input_cache_creation: 10,
    };
    const result = TokenUsageSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("rejects missing fields", () => {
    const input = { input_other: 100 };
    const result = TokenUsageSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// DisplayBlock Tests
// ============================================================================
describe("DisplayBlockSchema", () => {
  it("parses brief block", () => {
    const input = { type: "brief", text: "Summary text" };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "brief", text: "Summary text" });
  });

  it("parses diff block", () => {
    const input = {
      type: "diff",
      path: "/src/main.ts",
      old_text: "const a = 1;",
      new_text: "const a = 2;",
    };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    const data = result.data! as DiffBlock;
    expect(data.type).toBe("diff");
    expect(data.path).toBe("/src/main.ts");
  });

  it("parses todo block", () => {
    const input = {
      type: "todo",
      items: [
        { title: "Task 1", status: "done" },
        { title: "Task 2", status: "in_progress" },
        { title: "Task 3", status: "pending" },
      ],
    };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    const data = result.data! as TodoBlock;
    expect(data.items).toHaveLength(3);
  });

  it("normalizes completed todo status to done", () => {
    const input = {
      type: "todo",
      items: [
        { title: "Task 1", status: "completed" },
        { title: "Task 2", status: "active" },
      ],
    };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    const data = result.data! as TodoBlock;
    expect(data.items.map((item) => item.status)).toEqual(["done", "in_progress"]);
  });

  it("parses command approval block", () => {
    const input = {
      type: "command",
      language: "bash",
      command: "pnpm test",
      cwd: "/repo",
      description: "Run tests",
      danger: "none",
    };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect((result.data as CommandBlock).command).toBe("pnpm test");
  });

  it("parses background-task approval block with task_id", () => {
    const input = {
      type: "background-task",
      task_id: "task-1",
      kind: "shell",
      status: "running",
      description: "Run tests",
    };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect((result.data as BackgroundTaskBlock).task_id).toBe("task-1");
  });

  it("transforms unknown block type to UnknownBlock", () => {
    const input = { type: "custom", foo: "bar", baz: 123 };
    const result = DisplayBlockSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data!.type).toBe("custom");
    expect((result.data as UnknownBlock).data).toEqual({ foo: "bar", baz: 123 });
  });
});

// ============================================================================
// ToolCall Tests
// ============================================================================
describe("ToolCallSchema", () => {
  it("parses valid tool call", () => {
    const input = {
      type: "function",
      id: "tc-123",
      function: {
        name: "Shell",
        arguments: '{"command": "ls -la"}',
      },
    };
    const result = ToolCallSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe("tc-123");
    expect(result.data?.function.name).toBe("Shell");
  });

  it("parses tool call with null arguments (streaming)", () => {
    const input = {
      type: "function",
      id: "tc-456",
      function: { name: "ReadFile", arguments: null },
    };
    const result = ToolCallSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses tool call with extras", () => {
    const input = {
      type: "function",
      id: "tc-789",
      function: { name: "WriteFile" },
      extras: { debug: true, timestamp: 1234567890 },
    };
    const result = ToolCallSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.extras).toEqual({ debug: true, timestamp: 1234567890 });
  });
});

// ============================================================================
// ToolCallPart Tests
// ============================================================================
describe("ToolCallPartSchema", () => {
  it("parses arguments part", () => {
    const input = { tool_call_id: "tc-1", arguments_part: '": "hello' };
    const result = ToolCallPartSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.tool_call_id).toBe("tc-1");
    expect(result.data?.arguments_part).toBe('": "hello');
  });

  it("parses null arguments part", () => {
    const input = { tool_call_id: "tc-1", arguments_part: null };
    const result = ToolCallPartSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects missing tool call id", () => {
    const input = {};
    const result = ToolCallPartSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ToolResult Tests
// ============================================================================
describe("ToolResultSchema", () => {
  it("parses successful result with string output", () => {
    const input = {
      tool_call_id: "tc-123",
      return_value: {
        is_error: false,
        output: "file contents here",
        message: "File read successfully",
        display: [{ type: "brief", text: "Read 100 lines" }],
      },
    };
    const result = ToolResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.return_value.is_error).toBe(false);
  });

  it("parses error result", () => {
    const input = {
      tool_call_id: "tc-456",
      return_value: {
        is_error: true,
        output: "Error: File not found",
        message: "Failed to read file",
        display: [],
      },
    };
    const result = ToolResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.return_value.is_error).toBe(true);
  });

  it("parses result with ContentPart array output", () => {
    const input = {
      tool_call_id: "tc-789",
      return_value: {
        is_error: false,
        output: [
          { type: "text", text: "Result part 1" },
          { type: "text", text: "Result part 2" },
        ],
        message: "OK",
        display: [],
      },
    };
    const result = ToolResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Event Payload Tests
// ============================================================================
describe("TurnBeginSchema", () => {
  it("parses string user input", () => {
    const input = { user_input: "Hello, Kimi!" };
    const result = TurnBeginSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.user_input).toBe("Hello, Kimi!");
  });

  it("parses ContentPart array user input", () => {
    const input = {
      user_input: [
        { type: "text", text: "Check this image:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
      ],
    };
    const result = TurnBeginSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("StepBeginSchema", () => {
  it("parses step begin", () => {
    const input = { n: 1 };
    const result = StepBeginSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.n).toBe(1);
  });

  it("parses high step number", () => {
    const input = { n: 100 };
    const result = StepBeginSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("StatusUpdateSchema", () => {
  it("parses full status update", () => {
    const input = {
      context_usage: 0.75,
      context_tokens: 12_345,
      max_context_tokens: 200_000,
      token_usage: {
        input_other: 1000,
        output: 500,
        input_cache_read: 200,
        input_cache_creation: 100,
      },
      message_id: "msg-123",
    };
    const result = StatusUpdateSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.context_usage).toBe(0.75);
    expect(result.data?.context_tokens).toBe(12_345);
    expect(result.data?.max_context_tokens).toBe(200_000);
  });

  it("parses partial status update", () => {
    const input = { context_usage: 0.5 };
    const result = StatusUpdateSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses empty status update", () => {
    const input = {};
    const result = StatusUpdateSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses null values", () => {
    const input = {
      context_usage: null,
      context_tokens: null,
      max_context_tokens: null,
      token_usage: null,
      message_id: null,
    };
    const result = StatusUpdateSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("ApprovalRequestPayloadSchema", () => {
  it("parses approval request", () => {
    const input = {
      id: "req-123",
      tool_call_id: "tc-456",
      sender: "Shell",
      action: "run shell command",
      description: "Run command `rm -rf node_modules`",
      display: [{ type: "brief", text: "Delete node_modules" }],
    };
    const result = ApprovalRequestPayloadSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.sender).toBe("Shell");
  });

  it("parses without display", () => {
    const input = {
      id: "req-789",
      tool_call_id: "tc-101",
      sender: "WriteFile",
      action: "write file",
      description: "Write to /src/main.ts",
    };
    const result = ApprovalRequestPayloadSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("PlanSchema", () => {
  it("parses ACP plan entries", () => {
    const input = {
      entries: [
        { content: "Inspect protocol", status: "completed", priority: "high" },
        { content: "Update webview", status: "in_progress" },
        { content: "Run checks", status: "pending", priority: "medium" },
      ],
    };
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.entries).toHaveLength(3);
  });
});

describe("ConfigOptionUpdateSchema", () => {
  it("parses flexible ACP config options", () => {
    const input = {
      configOptions: [
        {
          configId: "model",
          value: "kimi-k2",
          options: [{ value: "kimi-k2", label: "Kimi K2" }],
        },
      ],
    };
    const result = ConfigOptionUpdateSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.configOptions[0]).toMatchObject({ configId: "model" });
  });
});

describe("ApprovalRequestResolvedSchema", () => {
  it("parses all response types", () => {
    const responses = ["approve", "approve_for_session", "reject"] as const;
    for (const response of responses) {
      const input = { request_id: "req-123", response };
      const result = ApprovalRequestResolvedSchema.safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data?.response).toBe(response);
    }
  });
});

describe("ApprovalResponseSchema", () => {
  it("accepts valid responses", () => {
    expect(ApprovalResponseSchema.safeParse("approve").success).toBe(true);
    expect(ApprovalResponseSchema.safeParse("approve_for_session").success).toBe(true);
    expect(ApprovalResponseSchema.safeParse("reject").success).toBe(true);
  });

  it("rejects invalid response", () => {
    expect(ApprovalResponseSchema.safeParse("invalid").success).toBe(false);
  });
});

// ============================================================================
// RunResult Tests
// ============================================================================
describe("RunResultSchema", () => {
  it("parses finished status", () => {
    const input = { status: "finished" };
    const result = RunResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("finished");
  });

  it("parses cancelled status", () => {
    const input = { status: "cancelled" };
    const result = RunResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses max_steps_reached with steps", () => {
    const input = { status: "max_steps_reached", steps: 100 };
    const result = RunResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.steps).toBe(100);
  });
});

// ============================================================================
// RpcMessage Tests
// ============================================================================
describe("RpcMessageSchema", () => {
  it("parses request message", () => {
    const input = {
      jsonrpc: "2.0",
      id: "1",
      method: "prompt",
      params: { user_input: "hello" },
    };
    const result = RpcMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses response message", () => {
    const input = {
      jsonrpc: "2.0",
      id: "1",
      result: { status: "finished" },
    };
    const result = RpcMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses error response", () => {
    const input = {
      jsonrpc: "2.0",
      id: "1",
      error: { code: -32001, message: "LLM not set" },
    };
    const result = RpcMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.error?.code).toBe(-32001);
  });

  it("parses notification (no id)", () => {
    const input = {
      jsonrpc: "2.0",
      method: "event",
      params: { type: "ContentPart", payload: { type: "text", text: "hi" } },
    };
    const result = RpcMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.id).toBeUndefined();
  });
});

// ============================================================================
// parseEventPayload Tests
// ============================================================================
describe("parseEventPayload", () => {
  it("parses TurnBegin event", () => {
    const result = parseEventPayload("TurnBegin", { user_input: "hello" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("TurnBegin");
      expect((result.value as WireEvent & { type: "TurnBegin" }).payload.user_input).toBe("hello");
    }
  });

  it("parses StepBegin event", () => {
    const result = parseEventPayload("StepBegin", { n: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("StepBegin");
    }
  });

  it("parses empty payload events", () => {
    const emptyEvents = ["StepInterrupted", "CompactionBegin", "CompactionEnd"];
    for (const type of emptyEvents) {
      const result = parseEventPayload(type, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe(type);
      }
    }
  });

  it("parses StatusUpdate event", () => {
    const result = parseEventPayload("StatusUpdate", { context_usage: 0.5 });
    expect(result.ok).toBe(true);
  });

  it("parses ContentPart event", () => {
    const result = parseEventPayload("ContentPart", { type: "text", text: "hello" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("ContentPart");
    }
  });

  it("parses ToolCall event", () => {
    const result = parseEventPayload("ToolCall", {
      type: "function",
      id: "tc-1",
      function: { name: "Shell", arguments: "{}" },
    });
    expect(result.ok).toBe(true);
  });

  it("parses ToolCallPart event", () => {
    const result = parseEventPayload("ToolCallPart", { tool_call_id: "tc-1", arguments_part: "more args" });
    expect(result.ok).toBe(true);
  });

  it("parses ToolResult event", () => {
    const result = parseEventPayload("ToolResult", {
      tool_call_id: "tc-1",
      return_value: {
        is_error: false,
        output: "ok",
        message: "done",
        display: [],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("parses ApprovalRequestResolved event", () => {
    const result = parseEventPayload("ApprovalRequestResolved", {
      request_id: "req-1",
      response: "approve",
    });
    expect(result.ok).toBe(true);
  });

  it("returns error for unknown event type", () => {
    const result = parseEventPayload("UnknownType", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown event type");
    }
  });

  it("returns error for invalid payload", () => {
    const result = parseEventPayload("StepBegin", { n: "not a number" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid payload");
    }
  });
});

// ============================================================================
// parseRequestPayload Tests
// ============================================================================
describe("parseRequestPayload", () => {
  it("parses ApprovalRequest", () => {
    const result = parseRequestPayload("ApprovalRequest", {
      id: "req-1",
      tool_call_id: "tc-1",
      sender: "Shell",
      action: "run command",
      description: "Run `ls`",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("ApprovalRequest");
      expect(result.value.payload.sender).toBe("Shell");
    }
  });

  it("returns error for unknown request type", () => {
    const result = parseRequestPayload("UnknownRequest", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown request type");
    }
  });

  it("returns error for invalid payload", () => {
    const result = parseRequestPayload("ApprovalRequest", { id: 123 });
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// SubagentEvent Tests
// ============================================================================
describe("SubagentEvent parsing", () => {
  it("parses nested SubagentEvent via parseEventPayload", () => {
    const result = parseEventPayload("SubagentEvent", {
      task_tool_call_id: "task-1",
      event: {
        type: "ContentPart",
        payload: { type: "text", text: "from subagent" },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === "SubagentEvent") {
      expect(result.value.payload.task_tool_call_id).toBe("task-1");
      expect(result.value.payload.event.type).toBe("ContentPart");
    }
  });
});

// ============================================================================
// JSON Round-trip Tests
// ============================================================================
describe("JSON round-trip", () => {
  it("ContentPart text survives JSON round-trip", () => {
    const original = { type: "text" as const, text: "hello world" };
    const json = JSON.stringify(original);
    const parsed = ContentPartSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  it("ToolCall survives JSON round-trip", () => {
    const original = {
      type: "function" as const,
      id: "tc-123",
      function: { name: "Shell", arguments: '{"cmd":"ls"}' },
    };
    const json = JSON.stringify(original);
    const parsed = ToolCallSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  it("RunResult survives JSON round-trip", () => {
    const original = { status: "finished" as const };
    const json = JSON.stringify(original);
    const parsed = RunResultSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });
});
