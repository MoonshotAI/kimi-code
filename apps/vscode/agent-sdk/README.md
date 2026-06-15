# @moonshot-ai/kimi-code-vscode-agent-sdk

TypeScript SDK for interacting with Kimi Code CLI via ACP (Agent Client Protocol) over stdio. Targets `kimi --version >= 0.14.0`.

## Usage

This is a private workspace package for `apps/vscode`.

## Quick Start

```typescript
import { createSession } from '@moonshot-ai/kimi-code-vscode-agent-sdk';

const session = createSession({
  workDir: '/path/to/project',
  model: 'kimi-latest',
  thinking: true,
});

const turn = session.prompt('Explain this codebase');

for await (const event of turn) {
  if (event.type === 'ContentPart' && event.payload.type === 'text') {
    process.stdout.write(event.payload.text);
  }
}

await session.close();
```

## API Reference

### Session Management

#### `createSession(options: SessionOptions): Session`

Creates a new session instance.

```typescript
interface SessionOptions {
  workDir: string;           // Working directory path
  sessionId?: string;        // Optional session ID (auto-generated if omitted)
  model?: string;            // Model identifier
  thinking?: boolean;        // Enable thinking mode
  mode?: AgentMode;          // ACP mode: 'default' | 'plan' | 'auto' | 'yolo'
  yoloMode?: boolean;        // Compatibility alias for mode === 'yolo'
  executable?: string;       // Path to CLI executable (default: "kimi")
  env?: Record<string, string>; // Environment variables
}

type AgentMode = 'default' | 'plan' | 'auto' | 'yolo';
```

`mode` maps directly to ACP `session/set_config_option { configId: "mode" }`.
`yoloMode` is kept for compatibility and is equivalent to `mode: "yolo"` when
true, otherwise `mode: "default"`.

#### `Session`

```typescript
interface Session {
  readonly sessionId: string;
  readonly workDir: string;
  readonly state: SessionState;  // 'idle' | 'active' | 'closed'

  // Configurable properties
  model: string | undefined;
  thinking: boolean;
  mode: AgentMode;
  yoloMode: boolean;
  executable: string;
  env: Record<string, string>;

  // Methods
  prompt(content: string | ContentPart[]): Turn;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

#### `Turn`

Represents an ongoing conversation turn.

```typescript
interface Turn {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent, RunResult, undefined>;
  interrupt(): Promise<void>;
  // requestId is the ACP JSON-RPC id and may be a number (incl. 0); pass it back
  // unchanged. ApprovalResult is a fixed ApprovalResponse or a dynamic { optionId }.
  approve(requestId: string | number, response: ApprovalResult): Promise<void>;
  readonly result: Promise<RunResult>;
}
```

#### `prompt(content, options): Promise<{ result, events }>`

One-shot prompt helper for simple use cases.

```typescript
import { prompt } from '@moonshot-ai/kimi-code-vscode-agent-sdk';

const { result, events } = await prompt('What does this code do?', {
  workDir: '/path/to/project',
  model: 'kimi-latest',
});
```

---

### Stream Events

Events emitted during a turn:

| Event Type | Payload | Description |
|------------|---------|-------------|
| `TurnBegin` | `{ user_input }` | Turn started |
| `StepBegin` | `{ n }` | New step started |
| `StepInterrupted` | `{}` | Step was interrupted |
| `ContentPart` | `ContentPart` | Text or thinking content |
| `ToolCall` | `ToolCall` | Tool invocation started |
| `ToolCallPart` | `{ tool_call_id, arguments_part }` | Streaming tool arguments |
| `ToolResult` | `ToolResult` | Tool execution result |
| `SubagentEvent` | `SubagentEvent` | Nested agent event |
| `StatusUpdate` | `StatusUpdate` | Token usage and context info |
| `CompactionBegin` | `{}` | Context compaction started |
| `CompactionEnd` | `{}` | Context compaction finished |
| `Plan` | `Plan` | Plan / TodoList update (replaces the whole plan) |
| `ConfigOptionUpdate` | `ConfigOptionUpdate` | Server-reported config option change |
| `AvailableCommandsUpdate` | `AvailableCommandsUpdate` | Dynamic slash commands (built-in Skills, 0.14+) |
| `ApprovalRequest` | `ApprovalRequestPayload` | Tool needs approval |
| `ApprovalRequestResolved` | `ApprovalRequestResolved` | An approval request was answered |

`AvailableCommandsUpdate` is wired through the SDK, but compatible `kimi` builds may
legitimately report an empty command list.

### ACP → legacy event contract

`AcpLegacyEventTranslator` is the VS Code ACP compatibility layer. It currently
maps these ACP notifications/requests and Kimi extension notifications into the
legacy `StreamEvent` shape:

| ACP input | Legacy output |
|---|---|
| `session/update.user_message_chunk` | `TurnBegin` + `StepBegin` |
| `session/update.agent_message_chunk` | `ContentPart` text |
| `session/update.agent_thought_chunk` | `ContentPart` think |
| `session/update.tool_call` | `ToolCall` |
| `session/update.tool_call_update` | `ToolCall`, `ToolCallPart`, terminal `ToolResult` |
| `session/update.plan` | `Plan` |
| `session/update.config_option_update` | `ConfigOptionUpdate` |
| `session/update.available_commands_update` | `AvailableCommandsUpdate` |
| `session/update.usage_update` | `StatusUpdate` |
| `session/request_permission` | `ApprovalRequest` |
| `session/prompt` response `stopReason: "max_turn_requests"` | `RunResult.status: "max_steps_reached"` |
| `kimi/step_interrupted` | `StepInterrupted` |
| `kimi/compaction` `phase: "started"` | `CompactionBegin` |
| `kimi/compaction` `phase: "completed"` / `"cancelled"` / `"blocked"` | `CompactionEnd` |
| `kimi/subagent_event` | `SubagentEvent` |

`StatusUpdate` is produced from ACP's experimental `usage_update` notification.
Because ACP 0.23 does not define standard compaction, step interruption, or
subagent activity variants, those flows use Kimi extension notifications until a
future ACP server-side wire contract supersedes them.

Unknown ACP `session/update` variants are intentionally ignored for forward
compatibility. When `KIMI_CODE_DEBUG_ACP=1`, the protocol client logs the unknown
`sessionUpdate` name, and `tests/fixtures/acp-legacy/session-update-unknown.json`
locks the current legacy output to an empty event list.

This package uses `@moonshot-ai/acp-adapter/protocol` only for type-only ACP wire
shapes. It still does not value-import the shared ACP adapter root entrypoint,
because that entrypoint also exports runtime server/session code.

---

### Content Types

#### `ContentPart`

```typescript
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'think'; think: string; encrypted?: string | null }
  | { type: 'image_url'; image_url: { url: string; id?: string | null } }
  | { type: 'audio_url'; audio_url: { url: string; id?: string | null } }
  | { type: 'video_url'; video_url: { url: string; id?: string | null } };
```

#### `ToolCall`

```typescript
interface ToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: string | null;
  };
  extras?: Record<string, unknown> | null;
}
```

#### `ToolResult`

```typescript
interface ToolResult {
  tool_call_id: string;
  return_value: {
    is_error: boolean;
    output: string | ContentPart[];
    message: string;
    display: DisplayBlock[];
    extras?: Record<string, unknown> | null;
  };
}
```

#### `DisplayBlock`

```typescript
type DisplayBlock =
  | { type: 'brief'; text: string }
  | { type: 'diff'; path: string; old_text: string; new_text: string }
  | { type: 'todo'; items: Array<{ title: string; status: 'pending' | 'in_progress' | 'done' }> }
  | { type: string; data: Record<string, unknown> };  // Unknown block
```

#### `RunResult`

```typescript
interface RunResult {
  status: 'finished' | 'cancelled' | 'max_steps_reached';
  steps?: number;
}
```

#### `ApprovalResponse`

```typescript
type ApprovalResponse = 'approve' | 'approve_for_session' | 'reject';
type ApprovalResult = ApprovalResponse | { optionId: string };

interface ApprovalRequestResolved {
  request_id: string | number;
  response: ApprovalResult;
}
```

---

### Session Storage

#### `listSessions(workDir: string): Promise<SessionInfo[]>`

Lists all sessions for a workspace.

```typescript
interface SessionInfo {
  id: string;
  workDir: string;
  contextFile: string;
  updatedAt: number;   // Timestamp in milliseconds
  brief: string;       // First user message preview
}
```

#### `deleteSession(workDir: string, sessionId: string): Promise<boolean>`

Deletes a session. Returns `true` if successful.

#### `parseSessionEvents(workDir: string, sessionId: string): Promise<StreamEvent[]>`

Parses and returns all events from a session's history.

---

### Configuration

#### `parseConfig(): KimiConfig`

Reads and parses the CLI configuration file.

```typescript
interface KimiConfig {
  defaultModel: string | null;
  defaultThinking: boolean;
  models: ModelConfig[];
}

interface ModelConfig {
  id: string;
  name: string;
  capabilities: string[];  // 'thinking' | 'always_thinking' | 'image_in' | 'video_in'
}
```

#### `saveDefaultModel(modelId: string, thinking?: boolean): void`

Updates the default model in the configuration file.

#### `getModelById(models: ModelConfig[], modelId: string): ModelConfig | undefined`

Finds a model by ID.

#### `getModelThinkingMode(model: ModelConfig): ThinkingMode`

Returns the thinking mode for a model.

```typescript
type ThinkingMode = 'none' | 'switch' | 'always';
```

#### `isModelThinking(models: ModelConfig[], modelId: string): boolean`

Checks if a model supports thinking.

---

### MCP Server Management

MCP servers are configured by the Kimi Code CLI. Run `kimi` in a terminal and use `/mcp-config` to add, edit, authenticate, or test servers. The VS Code extension only keeps a read-only MCP guide page and intentionally does not expose add/update/remove/auth/test bridge entry points.

#### `MCPServerConfig`

```typescript
interface MCPServerConfig {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;              // For HTTP transport
  command?: string;          // For stdio transport
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: 'oauth';
}
```

---

### File Paths

#### `KimiPaths`

Utility object for Kimi CLI file paths.

```typescript
const KimiPaths = {
  home: string;                                    // ~/.kimi-code
  config: string;                                  // ~/.kimi-code/config.toml
  mcpConfig: string;                               // ~/.kimi-code/mcp.json
  sessionsDir(workDir: string): string;            // Session storage directory
  sessionDir(workDir: string, sessionId: string): string;
  shadowGitDir(workDir: string, sessionId: string): string;
};
```

---

### Error Handling

All errors extend `AgentSdkError`:

```typescript
abstract class AgentSdkError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

type ErrorCategory = 'transport' | 'protocol' | 'session' | 'cli';
```

#### Error Classes

| Class | Category | Codes |
|-------|----------|-------|
| `TransportError` | transport | `SPAWN_FAILED`, `STDIN_NOT_WRITABLE`, `PROCESS_CRASHED`, `CLI_NOT_FOUND`, `ALREADY_STARTED`, `HANDSHAKE_TIMEOUT` |
| `ProtocolError` | protocol | `INVALID_JSON`, `SCHEMA_MISMATCH`, `UNKNOWN_EVENT_TYPE`, `UNKNOWN_REQUEST_TYPE`, `REQUEST_TIMEOUT`, `REQUEST_CANCELLED` |
| `SessionError` | session | `SESSION_CLOSED`, `SESSION_BUSY`, `TURN_INTERRUPTED`, `APPROVAL_FAILED` |
| `CliError` | cli | `AUTH_REQUIRED`, `INVALID_STATE`, `LLM_NOT_SET`, `LLM_NOT_SUPPORTED`, `CHAT_PROVIDER_ERROR`, `CONFIG_ERROR`, `INVALID_PARAMS`, `UNKNOWN` |

#### Error Utilities

```typescript
// Check if error is from this SDK
isAgentSdkError(err: unknown): err is AgentSdkError

// Get error code (returns 'UNKNOWN' for non-SDK errors)
getErrorCode(err: unknown): string

// Get error category (returns 'unknown' for non-SDK errors)
getErrorCategory(err: unknown): ErrorCategory | 'unknown'
```

---

### Utility Functions

#### `extractBrief(display?: DisplayBlock[]): string`

Extracts brief text from display blocks.

#### `extractTextFromContentParts(parts: ContentPart[]): string`

Extracts all text content from content parts.

#### `formatContentOutput(output: string | ContentPart[]): string`

Formats content output as a string.

---

## Usage Examples

### Handling Tool Approvals

```typescript
const turn = session.prompt('Delete all .tmp files');

for await (const event of turn) {
  if (event.type === 'ApprovalRequest') {
    const { id, action, description } = event.payload;
    console.log(`Approval needed: ${action} - ${description}`);

    // Approve or reject
    await turn.approve(id, 'approve');
  }
}
```

### Streaming with Token Usage

```typescript
for await (const event of turn) {
  if (event.type === 'StatusUpdate') {
    const { token_usage, context_usage } = event.payload;
    if (token_usage) {
      console.log(`Tokens: ${token_usage.input_other} in, ${token_usage.output} out`);
    }
  }
}
```

### Handling Subagent Events

```typescript
for await (const event of turn) {
  if (event.type === 'SubagentEvent') {
    const { task_tool_call_id, event: subEvent } = event.payload;
    console.log(`Subagent ${task_tool_call_id}: ${subEvent.type}`);
  }
}
```

### Interrupting a Turn

```typescript
const turn = session.prompt('Long running task...');

// Interrupt after 10 seconds
setTimeout(() => turn.interrupt(), 10000);

for await (const event of turn) {
  // Handle events until interrupted
}

const result = await turn.result;
console.log(result.status);  // 'cancelled'
```

### Multi-turn Conversation with Image Input

```typescript
import { createSession, type ContentPart } from '@moonshot-ai/kimi-code-vscode-agent-sdk';

async function analyzeImage() {
  const session = createSession({
    workDir: process.cwd(),
    model: 'kimi-vision',
    thinking: true,
  });

  // First turn: send image with question
  const imageContent: ContentPart[] = [
    { type: 'text', text: 'What is shown in this image?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo...' } },
  ];

  const turn1 = session.prompt(imageContent);
  for await (const event of turn1) {
    if (event.type === 'ContentPart' && event.payload.type === 'text') {
      process.stdout.write(event.payload.text);
    }
  }

  // Second turn: follow-up question (session maintains context)
  const turn2 = session.prompt('Can you identify any potential issues?');
  for await (const event of turn2) {
    if (event.type === 'ContentPart' && event.payload.type === 'text') {
      process.stdout.write(event.payload.text);
    }
  }

  await session.close();
}
```

### Resuming a Previous Session

```typescript
import {
  createSession,
  listSessions,
  parseSessionEvents,
  type StreamEvent
} from '@moonshot-ai/kimi-code-vscode-agent-sdk';

async function resumeSession(workDir: string) {
  // List existing sessions
  const sessions = await listSessions(workDir);

  if (sessions.length === 0) {
    console.log('No previous sessions found');
    return;
  }

  // Get the most recent session
  const latestSession = sessions[0];
  console.log(`Resuming session: ${latestSession.brief}`);

  // Load session history
  const history = await parseSessionEvents(workDir, latestSession.id);

  // Display previous messages
  for (const event of history) {
    if (event.type === 'TurnBegin') {
      const input = event.payload.user_input;
      const text = typeof input === 'string'
        ? input
        : input.filter(p => p.type === 'text').map(p => p.text).join('\n');
      console.log(`\nUser: ${text}`);
    }
    if (event.type === 'ContentPart' && event.payload.type === 'text') {
      process.stdout.write(event.payload.text);
    }
  }

  // Create session with existing ID to continue conversation
  const session = createSession({
    workDir,
    sessionId: latestSession.id,
    model: 'kimi-latest',
  });

  // Continue the conversation
  const turn = session.prompt('Please continue from where we left off');
  for await (const event of turn) {
    if (event.type === 'ContentPart' && event.payload.type === 'text') {
      process.stdout.write(event.payload.text);
    }
  }

  await session.close();
}
```
