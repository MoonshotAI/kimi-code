/// Rust agent engine adapter.
///
/// When `agent.engine = "rust"` is configured, this module provides
/// a drop-in replacement for the JS turn loop. Two transport modes are
/// supported, selected automatically at startup:
///
/// 1. **napi-rs** (preferred): The native `kimi_agent.node` addon is
///    loaded directly into the Node.js process. Host callbacks are
///    invoked as JS functions via ThreadsafeFunction — no serialization
///    overhead and no subprocess management.
/// 2. **stdio JSON-RPC** (fallback): The `kimi-agent-cli` Rust binary
///    is spawned as a child process and communicates via JSON-RPC over
///    stdin/stdout.
///
/// If neither is available, it falls back to the JS implementation.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

// A bare `require` only exists under CJS interop (vitest); in the ESM
// runtimes that actually ship — tsx dev mode and the tsdown bundle — it is a
// ReferenceError, which used to escape `isAvailable()` and silently demote
// every `engine = "rust"` session to the JS engine. createRequire works in
// all of them, and is also what loads the native addon.
const nodeRequire = createRequire(import.meta.url);

import {
  APIRequestTooLargeError,
  isImageFormatError,
  isRecoverableRequestStructureError,
} from '@moonshot-ai/kosong';

// ── Generated wire contract ────────────────────────────────────────────
// Regenerate with `pnpm gen:wire`; the source of truth is
// `src/rpc/types.rs` (serde shapes map 1:1 onto the JSON wire).
import type {
  AuthorizeToolRequest,
  AuthorizeToolResponse,
  ContentBlock,
  FinalizeToolRequest,
  FinalizeToolResponse,
  LlmChatRequest,
  LlmChatResponse,
  LlmProviderDef,
  Message,
  NativeLlmConfig,
  PrepareToolRequest,
  PrepareToolResponse,
  RunTurnParams,
  RunTurnResult,
  ToolExecuteRequest,
  ToolExecuteResponse,
} from './src/rpc/wire.gen';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname, '..', '..');

/**
 * Walk up from `start` at most `maxDepth` levels, returning the first
 * ancestor that contains `relative` (file or dir), or null. Resolves both
 * layouts: dev runs rust-loop.ts from `packages/kimi-agent` (repo root one
 * level up) and bundled builds run from `dist/chunks` (repo root several
 * levels up); production SEA deployments find `dist-native/bin` instead via
 * the explicit candidate list in `AgentProcess.findBinary`.
 */
function findUpward(start: string, relative: string, maxDepth = 8): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = nodeRequire('node:fs') as typeof import('node:fs');
  let current = start;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = resolve(current, relative);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Token usage carried on step.end (structurally matches kosong's TokenUsage). */
interface HostTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

const ZERO_USAGE: HostTokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

// ── Tool lifecycle hooks (tool_call.rs) ──────────────────────────────────

/**
 * Routing envelope for incoming RPC lines. Loose by design: it only discriminates
 * request/response/notification for routing. Payload shapes are the generated
 * wire types (imported above) — see `JsonRpcRequest`/`JsonRpcResponse` &
 * friends in `wire.gen.ts` when strict shapes are needed.
 */
type RpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Fire-and-forget engine event (Rust → host, `host/event`). */
interface EngineEvent {
  type: string;
  /** Owning session; multi-session hosts route events by this. */
  session_id?: string;
  [key: string]: unknown;
}

/**
 * Classify an incoming RPC line. A JSON-RPC request always carries `method`; a
 * response never does. Discriminating on `method` FIRST prevents a Rust host
 * request whose id collides with a pending request id from being mis-routed as
 * that request's response (both sides allocate ids from 1).
 */
export function classifyRpcMessage(msg: RpcMessage): 'request' | 'response' | 'ignore' {
  if (msg.method !== undefined) {
    return msg.id !== undefined ? 'request' : 'ignore';
  }
  return msg.id !== undefined ? 'response' : 'ignore';
}

// ── Napi result types (matching Rust JsRunTurnResult) ────────────────────

interface NapiRunTurnResult {
  stopReason: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ── Napi engine (in-process native addon) ─────────────────────────────────

/** Shape of the loaded `kimi_agent.node` native addon. */
interface KimiAgentNativeModule {
  getCallbackPayload(id: number): string | null;
  resolveCallback(id: number, error: string | null, result: string | null): void;
  /** Sets the per-turn cancellation flag; absent in pre-cancel addon builds. */
  cancelTurnRust?(turnId: string): boolean;
  runTurnRust(
    params: unknown,
    llmChatCb: (callbackId: number) => void,
    executeToolCb: (callbackId: number) => void,
    emitEventCb?: (callbackId: number) => void,
    prepareToolCb?: (callbackId: number) => void,
    authorizeToolCb?: (callbackId: number) => void,
    finalizeToolCb?: (callbackId: number) => void,
  ): Promise<NapiRunTurnResult>;
}

class NapiEngine {
  private nativeModule: KimiAgentNativeModule | null = null;
  private loaded = false;

  static findModule(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const candidates = [
      // Development: alongside rust-loop.ts in the package directory
      resolve(import.meta.dirname, 'kimi_agent.node'),
      // Production: may be bundled elsewhere — walk up to the repo root
      findUpward(import.meta.dirname, 'kimi_agent.node'),
      findUpward(import.meta.dirname, 'packages/kimi-agent/kimi_agent.node'),
    ].filter((c): c is string => c !== null);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
    return null;
  }

  static isAvailable(): boolean {
    return NapiEngine.findModule() !== null;
  }

  load(): boolean {
    if (this.loaded) return true;
    const modulePath = NapiEngine.findModule();
    if (!modulePath) {
      console.warn('[kimi-agent] napi module not found');
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.nativeModule = nodeRequire(modulePath) as KimiAgentNativeModule;
      this.loaded = true;
      return true;
    } catch (error) {
      console.warn('[kimi-agent] Failed to load napi module:', error);
      return false;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Set the per-turn cancellation flag inside the addon, stopping the turn
   * at its next step boundary. Returns false when the addon predates the
   * cancel export or no turn with this id is running.
   */
  cancelTurn(turnId: string): boolean {
    try {
      return this.nativeModule?.cancelTurnRust?.(turnId) === true;
    } catch {
      return false;
    }
  }

  /**
   * Call the native runTurnRust function.
   *
   * Internally wraps the callbacks to use the **callback registry** pattern:
   * Rust calls `(envelope: string) => void` where envelope is a JSON object
   * `{ id: number, payload: string }`. The wrapper parses the envelope,
   * calls the user's async callback with the payload, then resolves via
   * `resolveCallback(id, err?, result?)`.
   *
   * The two callbacks receive JSON-serialized request payloads and must
   * return JSON-serialized response payloads (or a Promise resolving to one):
   *   - llmChatCb: receives `LlmChatRequest` JSON, returns `LlmChatResponse` JSON
   *   - executeToolCb: receives `ToolExecuteRequest` JSON, returns `ToolExecuteResponse` JSON
   */
  async runTurn(
    params: {
      turnId: string;
      systemPrompt: string;
      modelName: string;
      messages: Array<{
        role: string;
        content: string;
        blocksJson?: string;
        toolCallsJson?: string;
        toolCallId?: string;
      }>;
      tools: Array<{ name: string; description: string; inputSchema: string }>;
      maxSteps?: number;
      goal?: {
        goalId: string;
        objective: string;
        status: string;
        tokenBudget?: number;
        turnBudget?: number;
        tokensUsed: number;
        turnsUsed: number;
      };
      nativeLlm?: {
        protocol: string;
        baseUrl: string;
        apiKey: string;
        model: string;
        maxTokens?: number;
      };
      workspaceRoot?: string;
      nativeTools?: boolean;
    },
    llmChatCb: (request: string) => Promise<string>,
    executeToolCb: (request: string) => Promise<string>,
    emitEventCb?: (event: EngineEvent) => void,
    lifecycleCbs?: {
      /** Each takes the JSON request and returns the JSON response ("null" = no hook decision). */
      prepareTool: (request: string) => Promise<string>;
      authorizeTool: (request: string) => Promise<string>;
      finalizeTool: (request: string) => Promise<string>;
    },
  ): Promise<NapiRunTurnResult> {
    if (!this.nativeModule) {
      throw new Error('Napi module not loaded');
    }

    const nativeModule = this.nativeModule;

    /**
     * Create a callback handler for the native module.
     *
     * The native module passes a `callbackId: number` to the JS callback.
     * The handler fetches the payload via `getCallbackPayload(id)`,
     * calls the user's async handler with the payload, then resolves via
     * `resolveCallback(id, error?, result?)`.
     */
    const makeCallbackHandler = (handler: (request: string) => Promise<string>) => {
      return (callbackId: number) => {
        const payload = nativeModule.getCallbackPayload(callbackId);
        if (!payload) return;
        // Wrap in try/catch: if `handler` (or any sync prologue such as
        // argument parsing) throws synchronously, `.then` would never be
        // registered and `resolveCallback` would never be called, leaving
        // the Rust side waiting on this callback forever (turn deadlock).
        try {
          Promise.resolve(handler(payload)).then(
            (result) => {
              nativeModule.resolveCallback(callbackId, null, result);
            },
            (error: unknown) => {
              nativeModule.resolveCallback(
                callbackId,
                error instanceof Error ? error.message : String(error),
                null,
              );
            },
          );
        } catch (error: unknown) {
          nativeModule.resolveCallback(
            callbackId,
            error instanceof Error ? error.message : String(error),
            null,
          );
        }
      };
    };

    // Fire-and-forget event channel: fetch the payload but never resolve.
    const eventHandler =
      emitEventCb === undefined
        ? undefined
        : (callbackId: number) => {
            const payload = nativeModule.getCallbackPayload(callbackId);
            if (!payload) return;
            try {
              emitEventCb(JSON.parse(payload) as EngineEvent);
            } catch {
              // Malformed events are dropped; they must never break the turn.
            }
          };

    return nativeModule.runTurnRust(
      params,
      makeCallbackHandler(llmChatCb),
      makeCallbackHandler(executeToolCb),
      eventHandler,
      // Tool-lifecycle channels: when all three are wired the engine reports
      // supports_tool_lifecycle and write-class tools run natively behind
      // the host approval gate; when absent they fall back to host execution.
      lifecycleCbs === undefined ? undefined : makeCallbackHandler(lifecycleCbs.prepareTool),
      lifecycleCbs === undefined ? undefined : makeCallbackHandler(lifecycleCbs.authorizeTool),
      lifecycleCbs === undefined ? undefined : makeCallbackHandler(lifecycleCbs.finalizeTool),
    );
  }
}

// ── Agent process manager (stdio JSON-RPC) ────────────────────────────────

class AgentProcess {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private ready = false;

  /** Callback for handling host/llm_chat requests from the Rust side. */
  private llmChatHandler: ((req: LlmChatRequest) => Promise<LlmChatResponse>) | null = null;

  /** Callback for handling host/execute_tool requests from the Rust side. */
  private toolExecuteHandler: ((req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) | null =
    null;

  /** Callback for handling host/prepare_tool_execution requests from the Rust side. */
  private prepareToolHandler:
    | ((req: PrepareToolRequest) => Promise<PrepareToolResponse | null>)
    | null = null;

  /** Callback for handling host/authorize_tool_execution requests from the Rust side. */
  private authorizeToolHandler:
    | ((req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>)
    | null = null;

  /** Callback for handling host/finalize_tool_result requests from the Rust side. */
  private finalizeToolHandler:
    | ((req: FinalizeToolRequest) => Promise<FinalizeToolResponse>)
    | null = null;

  /** Callback for fire-and-forget host/event notifications from Rust. */
  private eventHandler: ((event: EngineEvent) => void) | null = null;

  /**
   * Per-session host handlers (session-owned thin clients). The engine stamps
   * every host-bound request with its session id, so a multi-session host
   * routes callbacks here; requests without a session id (RUN_TURN override
   * path) fall back to the singleton handlers above.
   */
  private readonly sessionHandlers = new Map<string, SessionHostHandlers>();

  /**
   * Register the host handlers for one session-owned client. Replaces any
   * prior registration for the same session id.
   */
  registerSessionHandlers(sessionId: string, handlers: SessionHostHandlers): void {
    this.sessionHandlers.set(sessionId, handlers);
  }

  /** Remove a session-owned client's host handlers. */
  unregisterSessionHandlers(sessionId: string): void {
    this.sessionHandlers.delete(sessionId);
  }

  /** Resolve the handlers for a host request: session-scoped first, then the
   *  singleton (RUN_TURN path). */
  private resolveHandlers(sessionId: string | undefined): SessionHostHandlers | null {
    if (sessionId !== undefined) {
      const scoped = this.sessionHandlers.get(sessionId);
      if (scoped !== undefined) return scoped;
    }
    if (
      this.llmChatHandler === null &&
      this.toolExecuteHandler === null &&
      this.prepareToolHandler === null &&
      this.authorizeToolHandler === null &&
      this.finalizeToolHandler === null &&
      this.eventHandler === null
    ) {
      return null;
    }
    return {
      llmChat: this.llmChatHandler ?? (async () => {
        throw new Error('No LLM chat handler registered');
      }),
      toolExecute: this.toolExecuteHandler ?? (async () => {
        throw new Error('No tool execute handler registered');
      }),
      prepareTool: this.prepareToolHandler ?? undefined,
      authorizeTool: this.authorizeToolHandler ?? undefined,
      finalizeTool: this.finalizeToolHandler ?? undefined,
      onEvent: this.eventHandler ?? undefined,
    };
  }

  setLlmChatHandler(handler: (req: LlmChatRequest) => Promise<LlmChatResponse>) {
    this.llmChatHandler = handler;
  }

  setToolExecuteHandler(handler: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) {
    this.toolExecuteHandler = handler;
  }

  setPrepareToolHandler(handler: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>) {
    this.prepareToolHandler = handler;
  }

  setAuthorizeToolHandler(
    handler: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>,
  ) {
    this.authorizeToolHandler = handler;
  }

  setFinalizeToolHandler(handler: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>) {
    this.finalizeToolHandler = handler;
  }

  setEventHandler(handler: (event: EngineEvent) => void) {
    this.eventHandler = handler;
  }

  static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const arch = `${process.platform}-${process.arch}`;
    const devCandidates = [
      // Development: Rust build output. The Cargo workspace root (repo root)
      // is where builds land since the workspace-ification; the per-crate
      // target dir is the pre-workspace layout and may hold stale binaries.
      resolve(projectRoot, 'target/release/kimi-agent-cli' + ext),
      resolve(projectRoot, 'target/debug/kimi-agent-cli' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/release/kimi-agent-cli' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/debug/kimi-agent-cli' + ext),
      // Bundled layout: dist/chunks walks up to the repo root, so the same
      // target dirs resolve here too (findUpward probes every ancestor).
      findUpward(import.meta.dirname, 'target/release/kimi-agent-cli' + ext),
      findUpward(import.meta.dirname, 'target/debug/kimi-agent-cli' + ext),
      findUpward(import.meta.dirname, 'packages/kimi-agent/target/release/kimi-agent-cli' + ext),
      findUpward(import.meta.dirname, 'packages/kimi-agent/target/debug/kimi-agent-cli' + ext),
    ].filter((c): c is string => c !== null);
    try {
      const fs = nodeRequire('node:fs') as typeof import('node:fs');
      // Pick the most recently built dev binary rather than the first hit:
      // with two possible target layouts, path order would silently prefer
      // a stale build over the one `cargo build` just produced.
      let newest: { path: string; mtimeMs: number } | null = null;
      for (const candidate of devCandidates) {
        try {
          const stat = fs.statSync(candidate);
          if (newest === null || stat.mtimeMs > newest.mtimeMs) {
            newest = { path: candidate, mtimeMs: stat.mtimeMs };
          }
        } catch {
          // missing candidate
        }
      }
      if (newest !== null) return newest.path;
      // Production: bundled alongside the SEA binary
      const bundled = resolve(projectRoot, 'dist-native', 'bin', arch, 'kimi-agent-cli' + ext);
      if (fs.existsSync(bundled)) return bundled;
    } catch {
      // ignore
    }
    return null;
  }

  start(): boolean {
    const binaryPath = AgentProcess.findBinary();
    if (!binaryPath) {
      console.warn('[kimi-agent] Binary not found, falling back to JS engine');
      return false;
    }

    try {
      // Persist engine state (sessions, cron, background tasks) across
      // restarts: default the engine home under the user's data dir unless
      // the host already pinned one. Without it the engine's SQLite stores
      // stay in-memory and native sessions cannot be resumed.
      const env: Record<string, string | undefined> = { ...process.env };
      if (env['KIMI_AGENT_HOME'] === undefined || env['KIMI_AGENT_HOME'] === '') {
        const os = nodeRequire('node:os') as typeof import('node:os');
        const path = nodeRequire('node:path') as typeof import('node:path');
        env['KIMI_AGENT_HOME'] = path.join(os.homedir(), '.kimi-code', 'agent');
      }
      this.process = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr!.on('data', (_data: Buffer) => {
        // Suppress stderr output from the Rust binary to avoid corrupting
        // the TUI's terminal rendering. The Rust binary's debug logs (eprintln!)
        // would otherwise print directly to the terminal and cause duplicate lines.
      });

      this.process.on('exit', (code) => {
        console.warn(`[kimi-agent] Process exited with code ${code}`);
        this.process = null;
        for (const [id, { reject }] of this.pending) {
          reject(new Error(`Agent process exited with code ${code}`));
          this.pending.delete(id);
        }
      });

      this.ready = true;
      return true;
    } catch (error) {
      console.warn('[kimi-agent] Failed to start:', error);
      return false;
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as RpcMessage;

        switch (classifyRpcMessage(msg)) {
          case 'request':
            this.handleHostRequest(msg).catch((error) => {
              console.error('[kimi-agent] Failed to handle host request:', error);
            });
            break;
          case 'response': {
            if (this.pending.has(msg.id as number)) {
              const pending = this.pending.get(msg.id as number)!;
              if (msg.error) {
                pending.reject(new Error(msg.error.message));
              } else {
                pending.resolve(msg.result);
              }
              this.pending.delete(msg.id as number);
            }
            break;
          }
          case 'ignore':
            // A method without an id is a notification — the engine's
            // fire-and-forget event channel arrives this way.
            if (msg.method === 'host/event') {
              const event = msg.params as EngineEvent;
              const handlers = this.resolveHandlers(event?.session_id);
              if (handlers?.onEvent) {
                try {
                  handlers.onEvent(event);
                } catch {
                  // Event handler failures must never break the RPC loop.
                }
              }
            }
            break;
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  private async handleHostRequest(msg: RpcMessage) {
    if (msg.method === 'host/llm_chat') {
      await this.handleHostLlmChat(msg);
    } else if (msg.method === 'host/execute_tool') {
      await this.handleHostExecuteTool(msg);
    } else if (msg.method === 'host/prepare_tool_execution') {
      await this.handleHostPrepareTool(msg);
    } else if (msg.method === 'host/authorize_tool_execution') {
      await this.handleHostAuthorizeTool(msg);
    } else if (msg.method === 'host/finalize_tool_result') {
      await this.handleHostFinalizeTool(msg);
    } else {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      });
      this.process!.stdin!.write(response + '\n');
    }
  }

  private async handleHostLlmChat(msg: RpcMessage) {
    const handlers = this.resolveHandlers(
      (msg.params as { session_id?: string } | undefined)?.session_id,
    );
    if (!handlers) {
      this.writeHostError(msg.id, 'No LLM chat handler registered');
      return;
    }
    try {
      const result = await handlers.llmChat(msg.params as LlmChatRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostExecuteTool(msg: RpcMessage) {
    const handlers = this.resolveHandlers(
      (msg.params as { session_id?: string } | undefined)?.session_id,
    );
    if (!handlers) {
      this.writeHostError(msg.id, 'No tool execute handler registered');
      return;
    }
    try {
      const result = await handlers.toolExecute(msg.params as ToolExecuteRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostPrepareTool(msg: RpcMessage) {
    const handlers = this.resolveHandlers(
      (msg.params as { session_id?: string } | undefined)?.session_id,
    );
    if (!handlers?.prepareTool) {
      // No handler registered — respond with null (allow unchanged).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      const result = await handlers.prepareTool(msg.params as PrepareToolRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostAuthorizeTool(msg: RpcMessage) {
    const handlers = this.resolveHandlers(
      (msg.params as { session_id?: string } | undefined)?.session_id,
    );
    if (!handlers?.authorizeTool) {
      // No handler registered — respond with null (allow unchanged).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      const result = await handlers.authorizeTool(msg.params as AuthorizeToolRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostFinalizeTool(msg: RpcMessage) {
    const handlers = this.resolveHandlers(
      (msg.params as { session_id?: string } | undefined)?.session_id,
    );
    if (!handlers?.finalizeTool) {
      // No handler registered — respond with null (use result as-is).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      const result = await handlers.finalizeTool(msg.params as FinalizeToolRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private writeHostResult(id: unknown, result: unknown) {
    this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private writeHostError(id: unknown, message: string) {
    this.process!.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n',
    );
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.process || !this.ready) {
      throw new Error('Agent process is not running');
    }
    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
  }
}

// ── Engine selection ──────────────────────────────────────────────────────

/// Which transport is active for the current session.
type EngineMode = 'napi' | 'stdio' | 'js';

let engineMode: EngineMode = 'js';
let agentProcess: AgentProcess | null = null;
let napiEngine: NapiEngine | null = null;

/**
 * Initialize the Rust engine, preferring napi-rs over stdio JSON-RPC.
 * Returns the selected mode. Called once on first use; subsequent calls
 * return the same mode.
 */
function initEngine(): EngineMode {
  if (engineMode !== 'js') return engineMode;

  // The session-owned surface (`session/*`) is stdio-only. Setting
  // KIMI_AGENT_FORCE_STDIO=1 skips the napi fast path so hosts (and tests)
  // that need that surface reach the binary instead of the in-process addon.
  const forceStdio = globalThis.process?.env?.['KIMI_AGENT_FORCE_STDIO'] === '1';

  // 1) Try napi-rs first (in-process, no subprocess overhead)
  if (!forceStdio && NapiEngine.isAvailable()) {
    const engine = new NapiEngine();
    if (engine.load()) {
      napiEngine = engine;
      engineMode = 'napi';
      return 'napi';
    }
  }

  // 2) Fall back to stdio JSON-RPC
  const process = new AgentProcess();
  if (process.start()) {
    agentProcess = process;
    engineMode = 'stdio';
    return 'stdio';
  }

  // 3) Both unavailable — fall back to JS
  engineMode = 'js';
  return 'js';
}

function getAgent(): AgentProcess | null {
  initEngine();
  return agentProcess;
}

function getNapiEngine(): NapiEngine | null {
  initEngine();
  return napiEngine;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runTurnRust(
  params: RunTurnParams,
  handlers?: {
    llmChat?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
    toolExecute?: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>;
    prepareTool?: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>;
    authorizeTool?: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>;
    finalizeTool?: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>;
  },
): Promise<RunTurnResult | null> {
  const agent = getAgent();
  if (!agent) return null;

  if (handlers?.llmChat) {
    agent.setLlmChatHandler(handlers.llmChat);
  }
  if (handlers?.toolExecute) {
    agent.setToolExecuteHandler(handlers.toolExecute);
  }
  if (handlers?.prepareTool) {
    agent.setPrepareToolHandler(handlers.prepareTool);
  }
  if (handlers?.authorizeTool) {
    agent.setAuthorizeToolHandler(handlers.authorizeTool);
  }
  if (handlers?.finalizeTool) {
    agent.setFinalizeToolHandler(handlers.finalizeTool);
  }

  try {
    const result = await agent.request('agent/run_turn', params);
    return result as RunTurnResult;
  } catch (error) {
    console.error('[kimi-agent] RPC call failed:', error);
    return null;
  }
}

/**
 * Create a `RunTurnOverride` function compatible with the agent-core turn loop.
 *
 * This adapter bridges the JS `RunTurnInput` (from agent-core) and the Rust
 * kimi-agent binary. The host stays authoritative: Rust drives control flow
 * and calls back per step/tool, while the host owns the message history and
 * transcript. It:
 * 1. Sends `agent/run_turn` to the Rust binary (no message content — see below)
 * 2. Handles `host/llm_chat` by rebuilding messages from `context` and calling
 *    `input.llm.chat()`, dispatching step/content events as it goes
 * 3. Handles `host/execute_tool` by running the full tool lifecycle
 *    (prepare -> resolve -> authorize permission gate -> execute -> finalize)
 *    and dispatching tool.call / tool.result
 * 4. Maps the Rust response back to the JS `TurnResult` type
 *
 * Turn-lifecycle parity with the JS loop:
 * - Host-proxy mode: `hooks.beforeStep` (compaction, steer-buffer flush,
 *   context injection) runs before every model step and a blocking result
 *   fails the step; `recordStepUsage` / `hooks.afterStep` run after every
 *   step (goal token accounting), and a reported hard stop ends the turn at
 *   the next callback.
 * - Native-LLM mode: Rust owns the in-turn history, so `beforeStep` does NOT
 *   run mid-turn — steered messages land at continuation boundaries instead.
 *   Per-step accounting still runs, hooked into the `llm.step.end` event.
 * - `hooks.shouldContinueAfterStop` runs when the Rust drive stops; a granted
 *   continuation re-drives the engine with the remaining step budget (and,
 *   in native-LLM mode, re-serializes the history so flushed steers are seen).
 * - Abort: both transports set the engine's per-turn cancellation flag
 *   (stdio: `agent/cancel_turn`; napi: `cancelTurnRust`), checked before
 *   every Rust step — native-LLM turns included; host callbacks
 *   short-circuit on both transports; the result maps to stopReason
 *   'aborted' (never a failure). An in-flight provider request still
 *   finishes its current step before the flag takes effect.
 *
 * Returns `undefined` when the Rust binary is not available (falls back to JS).
 */

/** Native HTTP LLM transport config (generated from Rust `NativeLlmConfig`). */
export type NativeLlmDef = NativeLlmConfig;

/** Options controlling the native (in-Rust) execution paths. */
export interface RustEngineOptions {
  /** When set, the Rust engine calls this provider directly over HTTP. */
  nativeLlm?: NativeLlmDef;
  /** When true, Read/Grep/Glob execute inside the Rust process. */
  nativeTools?: boolean;
}

export function createRunTurnOverride(
  providers?: LlmProviderDef[],
  workspaceRoot?: string,
  options?: RustEngineOptions,
): import('@moonshot-ai/agent-core').RunTurnOverride | undefined {
  const mode = initEngine();
  if (mode === 'js') return undefined;

  const nativeLlm = options?.nativeLlm;
  const nativeTools = options?.nativeTools === true;

  // Build a lightweight workspace predictor for the Read prediction fast-path.
  // When the Rust engine calls host/execute_tool with force_precise=false for
  // a Read call, we return a prediction (first few lines + metadata) so the
  // LLM can continue immediately. The Rust engine then spawns a background
  // force_precise=true call, which executes the full read and replaces the
  // prediction in the transcript via input.replaceToolResult.
  const predictor = workspaceRoot ? new WorkspacePredictor(workspaceRoot) : undefined;

  return async (input) => {
    // The prediction fast-path requires transcript replacement. If the host
    // doesn't provide replaceToolResult, predictions are disabled and all
    // reads execute precisely on the first call.
    const predictionEnabled = predictor !== undefined && input.replaceToolResult !== undefined;

    // Step lifecycle. The host owns the transcript AND the message history:
    // Rust drives control flow and calls back per LLM step and per tool. We
    // open an assistant "step" on host/llm_chat and keep it open — recording
    // tool.call / tool.result against it — until the next llm_chat (or turn
    // end) closes it with step.end. buildMessages() re-reads `context` each
    // step, so these recorded events are exactly what thread history forward.
    let currentStep = 0;
    let openStep: { uuid: string; step: number; usage: HostTokenUsage } | undefined;
    const closeOpenStep = async (): Promise<void> => {
      if (openStep === undefined) return;
      const { uuid, step, usage } = openStep;
      openStep = undefined;
      await input.dispatchEvent({ type: 'step.end', uuid, turnId: input.turnId, step, usage });
    };
    const outputToContent = (output: unknown): string =>
      typeof output === 'string' ? output : JSON.stringify(output);

    // Ask the engine to stop this turn at its next step boundary. Both
    // transports expose a per-turn cancellation flag (stdio: the
    // `agent/cancel_turn` RPC; napi: the `cancelTurnRust` export) — this
    // stops native-LLM turns too, where the host llm callback never runs.
    const requestEngineCancel = (turnId: string): void => {
      if (mode === 'stdio') {
        void getAgent()
          ?.request('agent/cancel_turn', { turn_id: turnId })
          .catch(() => {});
      } else {
        getNapiEngine()?.cancelTurn(turnId);
      }
    };

    // ── Engine event handler (native LLM / native tool paths) ────────
    // Rust reports step boundaries, streaming deltas, and natively-executed
    // tool results over the fire-and-forget event channel. Events arrive
    // synchronously but dispatching is async, so they are serialized
    // through a promise chain to preserve transcript ordering.
    let eventChain: Promise<void> = Promise.resolve();
    const processEngineEvent = async (event: EngineEvent): Promise<void> => {
      switch (event.type) {
        case 'llm.step.begin': {
          await closeOpenStep();
          currentStep += 1;
          const stepUuid = randomUUID();
          await input.dispatchEvent({
            type: 'step.begin',
            uuid: stepUuid,
            turnId: input.turnId,
            step: currentStep,
          });
          openStep = { uuid: stepUuid, step: currentStep, usage: { ...ZERO_USAGE } };
          break;
        }
        case 'llm.delta': {
          if (openStep === undefined) break;
          const part = event['part'] as { type?: string; text?: string; think?: string };
          await input.dispatchEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: input.turnId,
            step: openStep.step,
            stepUuid: openStep.uuid,
            part: part as never,
          });
          // `content.part` only records into the context; the UI stream is the
          // separate `text.delta`/`thinking.delta` channel (mapped to
          // `assistant.delta` by the session-event projector). Without this,
          // print mode and the TUI render nothing for Rust-driven turns.
          if (part.type === 'text' && part.text !== undefined && part.text.length > 0) {
            input.dispatchEvent({ type: 'text.delta', delta: part.text });
          } else if (part.type === 'think' && part.think !== undefined && part.think.length > 0) {
            input.dispatchEvent({ type: 'thinking.delta', delta: part.think });
          }
          break;
        }
        case 'llm.step.end': {
          if (openStep === undefined) break;
          const usage = event['usage'] as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          openStep.usage = {
            inputOther: usage?.input_tokens ?? 0,
            output: usage?.output_tokens ?? 0,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          };
          // Native-LLM parity: this event only fires when Rust calls the
          // provider itself (llm/http.rs), where the host llm callback — and
          // with it the per-step accounting in `llmChatHandler` — never runs.
          // Goal token accounting (recordStepUsage + afterStep) hooks in here
          // instead. A reported hard stop asks the engine to abort at its
          // next step boundary (cancel_turn RPC on stdio, cancelTurnRust on
          // napi).
          const stepUsage = openStep.usage;
          lastStepUsage = stepUsage;
          const stepToolCalls = event['tool_calls'] as unknown[] | undefined;
          const recorded = await input.recordStepUsage?.(stepUsage);
          let stopAfterStep = recorded?.stopTurn === true;
          try {
            const after = await input.hooks?.afterStep?.({
              turnId: input.turnId,
              stepNumber: openStep.step,
              signal: input.signal,
              llm: input.llm,
              usage: stepUsage,
              stopReason: ((stepToolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn') as never,
            });
            stopAfterStep = stopAfterStep || after?.stopTurn === true;
          } catch {
            // Sealed step — observer hooks cannot change the result.
          }
          if (stopAfterStep) {
            stopTurnRequested = true;
            requestEngineCancel(input.turnId);
          }
          break;
        }
        case 'tool.native': {
          // A tool that executed inside the Rust process — mirror the
          // call/result pair into the transcript.
          if (openStep === undefined) break;
          const rawCallId = event['tool_call_id'];
          const toolCallId = typeof rawCallId === 'string' ? rawCallId : randomUUID();
          const toolName = typeof event['tool_name'] === 'string' ? event['tool_name'] : '';
          await input.dispatchEvent({
            type: 'tool.call',
            uuid: toolCallId,
            turnId: input.turnId,
            step: openStep.step,
            stepUuid: openStep.uuid,
            toolCallId,
            name: toolName,
            args: event['arguments'],
          });
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: toolCallId,
            toolCallId,
            result: { output: event['content'], isError: event['is_error'] === true } as never,
          });
          break;
        }
        default:
          break;
      }
    };
    const handleEngineEvent = (event: EngineEvent): void => {
      eventChain = eventChain.then(() => processEngineEvent(event)).catch(() => {});
    };

    // ── Native LLM initial messages ───────────────────────────────
    // When Rust calls the provider directly it owns the in-turn message
    // history, so the host serializes the current history (text, images,
    // and tool-call structure) once at turn start.
    interface HostContentPart {
      type: string;
      text?: string;
      imageUrl?: { url: string };
    }
    interface HostMessage {
      role: string;
      content: HostContentPart[];
      toolCalls?: { id: string; name: string; arguments: string | null }[];
      toolCallId?: string;
    }
    const toWireMessage = (m: HostMessage): Message => {
      let text = '';
      let hasMedia = false;
      const blocks: ContentBlock[] = [];
      for (const part of m.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          text += part.text;
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.imageUrl?.url !== undefined) {
          hasMedia = true;
          blocks.push({ type: 'image_url', url: part.imageUrl.url });
        }
        // think/audio/video parts are not projected to the native wire.
      }
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments === null ? {} : tryParseJson(tc.arguments),
      }));
      return {
        role: m.role,
        content: text,
        blocks: hasMedia ? blocks : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        tool_call_id: m.toolCallId,
      };
    };
    const buildWireMessages = async (): Promise<Message[]> => {
      const messages = (await input.buildMessages()) as unknown as HostMessage[];
      return messages.map(toWireMessage);
    };
    const buildWireTools = (): { name: string; description: string; parameters: unknown }[] => {
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      return stepTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t as { parameters?: unknown }).parameters ?? {},
      }));
    };

    // ── LLM chat handler ──────────────────────────────────────────────
    // Set when a completed step reports a reached hard limit (goal token
    // budget via recordStepUsage / afterStep). The next model-step callback
    // then ends the turn with a synthetic stop instead of running another
    // step — mirroring the JS loop, which stops after the step that hit the
    // limit. Reset at continuation boundaries so a granted extra step runs.
    let stopTurnRequested = false;
    let lastStepUsage: HostTokenUsage = { ...ZERO_USAGE };
    // Media projection state, turn-scoped as in the JS loop: once a step only
    // succeeded via the media-degraded / media-stripped resend, later steps
    // build from that projection directly — the full-media history is
    // deterministically over the provider's limit, so rebuilding it would pay
    // a fresh rejection on every step (see turn-step.ts).
    let mediaProjection: 'normal' | 'degraded' | 'stripped' = 'normal';
    const syntheticStop = (): LlmChatResponse => ({
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    const llmChatHandler = async (): Promise<LlmChatResponse> => {
      // An aborted turn must not run another model step. A clean synthetic
      // stop lets the Rust loop terminate; the final result maps to 'aborted'
      // (signal.aborted is re-checked there), so a cancel is never misread
      // as a turn failure. Same short-circuit for a host-requested stop.
      if (input.signal.aborted || stopTurnRequested) return syntheticStop();
      await closeOpenStep();
      currentStep += 1;
      const stepUuid = randomUUID();
      const stepNum = currentStep;
      // Pre-step lifecycle, as the JS loop runs it before each step
      // (turn-step.ts): compaction, steer-buffer flush, and context injection
      // all live in this hook, and a blocking result fails the step. Without
      // it, mid-turn steered messages (user interrupts, background-task
      // notifications) never reach the context, because `flushSteerBuffer`
      // is only ever called from these hooks. Host-proxy mode only: in
      // native-LLM mode this callback never runs (see the doc comment).
      const beforeStep = await input.hooks?.beforeStep?.({
        turnId: input.turnId,
        stepNumber: stepNum,
        signal: input.signal,
        llm: input.llm,
      });
      if (beforeStep?.block === true) {
        throw new Error(beforeStep.reason ?? `Step ${String(stepNum)} was blocked`);
      }
      await input.dispatchEvent({
        type: 'step.begin',
        uuid: stepUuid,
        turnId: input.turnId,
        step: stepNum,
      });
      openStep = { uuid: stepUuid, step: stepNum, usage: { ...ZERO_USAGE } };

      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const buildProjectedMessages = async () => {
        if (mediaProjection === 'stripped' && input.buildMessagesMediaStripped !== undefined) {
          return input.buildMessagesMediaStripped();
        }
        if (mediaProjection === 'degraded' && input.buildMessagesMediaDegraded !== undefined) {
          return input.buildMessagesMediaDegraded();
        }
        return input.buildMessages();
      };
      const chatOnce = async (messages: Awaited<ReturnType<typeof input.buildMessages>>) =>
        input.llm.chat({
          messages,
          tools: stepTools,
          signal: input.signal,
          onTextDelta: (delta: string) => {
            if (delta.length > 0) {
              input.dispatchEvent({ type: 'text.delta', delta });
            }
          },
          onThinkDelta: (delta: string) => {
            if (delta.length > 0) {
              input.dispatchEvent({ type: 'thinking.delta', delta });
            }
          },
          onTextPart: async (part) => {
            await input.dispatchEvent({
              type: 'content.part',
              uuid: randomUUID(),
              turnId: input.turnId,
              step: stepNum,
              stepUuid,
              part,
            });
            // Mirror to the UI stream — see the llm.delta handler.
            if (part.type === 'text' && part.text.length > 0) {
              input.dispatchEvent({ type: 'text.delta', delta: part.text });
            }
          },
          onThinkPart: async (part) => {
            await input.dispatchEvent({
              type: 'content.part',
              uuid: randomUUID(),
              turnId: input.turnId,
              step: stepNum,
              stepUuid,
              part,
            });
            if (part.type === 'think' && part.think.length > 0) {
              input.dispatchEvent({ type: 'thinking.delta', delta: part.think });
            }
          },
        });
      // The recovery ladder from the JS loop's `executeLoopStep`, host-proxy
      // edition. Without it a Rust-driven session stays stuck on request
      // rejections the JS loop recovers from:
      //   413 body-too-large → media-degraded resend → media-stripped resend
      //   image-format rejection → media-stripped resend
      //   structural 400 → one-shot strict wire-compliant rebuild
      // Successful media resends latch `mediaProjection` for later steps.
      // (Native-LLM mode never reaches this handler; the ladder is
      // host-proxy only.)
      const resendWithRecovery = async (
        error: unknown,
      ): Promise<Awaited<ReturnType<typeof chatOnce>>> => {
        if (error instanceof APIRequestTooLargeError) {
          if (mediaProjection === 'normal' && input.buildMessagesMediaDegraded !== undefined) {
            input.log?.warn('request body too large; resending with media degraded', {
              turnStep: `${input.turnId}.${String(stepNum)}`,
            });
            try {
              const recovered = await chatOnce(await input.buildMessagesMediaDegraded());
              mediaProjection = 'degraded';
              return recovered;
            } catch (secondError) {
              if (
                !(secondError instanceof APIRequestTooLargeError) ||
                input.buildMessagesMediaStripped === undefined
              ) {
                throw secondError;
              }
              const recovered = await chatOnce(await input.buildMessagesMediaStripped());
              mediaProjection = 'stripped';
              return recovered;
            }
          }
          if (mediaProjection !== 'stripped' && input.buildMessagesMediaStripped !== undefined) {
            const recovered = await chatOnce(await input.buildMessagesMediaStripped());
            mediaProjection = 'stripped';
            return recovered;
          }
          throw error;
        }
        if (
          isImageFormatError(error) &&
          mediaProjection !== 'stripped' &&
          input.buildMessagesMediaStripped !== undefined
        ) {
          input.log?.warn('provider rejected an image; resending with media stripped', {
            turnStep: `${input.turnId}.${String(stepNum)}`,
          });
          const recovered = await chatOnce(await input.buildMessagesMediaStripped());
          mediaProjection = 'stripped';
          return recovered;
        }
        if (isRecoverableRequestStructureError(error) && input.buildMessagesStrict !== undefined) {
          input.log?.warn('provider rejected request structure; resending with strict projection', {
            turnStep: `${input.turnId}.${String(stepNum)}`,
          });
          return chatOnce(await input.buildMessagesStrict());
        }
        throw error;
      };

      let response;
      try {
        response = await chatOnce(await buildProjectedMessages());
      } catch (error) {
        // A cancel usually surfaces as the in-flight chat rejecting on the
        // abort signal. Convert it into a synthetic stop so the Rust loop
        // terminates cleanly instead of retrying a "failed" step; the final
        // result still maps to 'aborted'.
        if (input.signal.aborted) return syntheticStop();
        try {
          response = await resendWithRecovery(error);
        } catch (finalError) {
          if (input.signal.aborted) return syntheticStop();
          throw finalError;
        }
      }
      if (openStep !== undefined) openStep.usage = response.usage;

      // Post-step lifecycle, as in the JS loop: goal token accounting first
      // (recordStepUsage), then afterStep (usage recording + compaction +
      // dedupe bookkeeping). Either may request a hard stop after this step.
      // afterStep failures are swallowed, matching turn-step.ts: the step is
      // already sealed, observer hooks cannot change the result.
      const stepUsage = response.usage ?? { ...ZERO_USAGE };
      lastStepUsage = stepUsage;
      const recorded = await input.recordStepUsage?.(stepUsage);
      if (recorded?.stopTurn === true) stopTurnRequested = true;
      try {
        const after = await input.hooks?.afterStep?.({
          turnId: input.turnId,
          stepNumber: stepNum,
          signal: input.signal,
          llm: input.llm,
          usage: stepUsage,
          stopReason: ((response.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn') as never,
        });
        if (after?.stopTurn === true) stopTurnRequested = true;
      } catch {
        // Sealed step — see above.
      }

      return {
        tool_calls:
          response.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments ? tryParseJson(tc.arguments) : null,
          })) ?? [],
        finish_reason: response.providerFinishReason ?? 'stop',
        usage: {
          input_tokens: response.usage?.inputOther ?? 0,
          output_tokens: response.usage?.output ?? 0,
          total_tokens: (response.usage?.inputOther ?? 0) + (response.usage?.output ?? 0),
        },
      };
    };

    // ── Tool execution handler ────────────────────────────────────────
    const toolExecuteHandler = async (req: ToolExecuteRequest): Promise<ToolExecuteResponse> => {
      // A cancelled turn stops executing tools immediately — the JS loop
      // settles every remaining call as aborted the same way.
      if (input.signal.aborted) {
        return { content: `Tool "${req.tool_name}" was aborted`, is_error: true };
      }
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const tool = stepTools.find((t) => t.name === req.tool_name);
      const toolCallId = req.tool_call_id;
      const stepUuid = openStep?.uuid;
      const stepNum = openStep?.step ?? currentStep;
      const toolCall = {
        type: 'function' as const,
        id: toolCallId,
        name: req.tool_name,
        arguments: req.arguments === undefined ? null : JSON.stringify(req.arguments),
      };

      const isPreciseReplacement = req.force_precise && predictionEnabled;

      let callDispatched = false;
      const emitCall = async (callArgs: unknown): Promise<void> => {
        if (callDispatched || stepUuid === undefined || isPreciseReplacement) return;
        callDispatched = true;
        await input.dispatchEvent({
          type: 'tool.call',
          uuid: toolCallId,
          turnId: input.turnId,
          step: stepNum,
          stepUuid,
          toolCallId,
          name: req.tool_name,
          args: callArgs,
        });
      };
      const settle = async (
        toolResult: { output: unknown; isError?: boolean | undefined; note?: string | undefined },
        callArgs: unknown,
      ): Promise<ToolExecuteResponse> => {
        if (isPreciseReplacement) {
          input.replaceToolResult(toolCallId, toolResult);
          return {
            content: outputToContent(toolResult.output),
            is_error: toolResult.isError === true,
          };
        }
        await emitCall(callArgs);
        if (stepUuid !== undefined) {
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: toolCallId,
            toolCallId,
            result: toolResult as never,
          });
        }
        return {
          content: outputToContent(toolResult.output),
          is_error: toolResult.isError === true,
        };
      };

      // ── Prediction fast-path ────────────────────────────────────────
      if (!req.force_precise && predictionEnabled && req.tool_name === 'read') {
        const args = req.arguments as { path?: string } | null;
        const filePath = args?.path;
        if (filePath) {
          const prediction = predictor.predictRead(filePath);
          if (prediction !== null) {
            await emitCall(req.arguments);
            if (stepUuid !== undefined) {
              await input.dispatchEvent({
                type: 'tool.result',
                parentUuid: toolCallId,
                toolCallId,
                result: { output: prediction } as never,
              });
            }
            return { content: prediction, is_error: false, is_prediction: true };
          }
        }
      }

      if (!tool) {
        const missing =
          input.describeMissingTool?.(req.tool_name) ?? `Tool "${req.tool_name}" not found`;
        return settle({ output: missing, isError: true }, req.arguments);
      }

      const hookCtxBase = {
        toolCall,
        toolCalls: [toolCall],
        tool,
        turnId: input.turnId,
        stepNumber: stepNum,
        signal: input.signal,
        llm: input.llm,
      };

      let effectiveArgs: unknown = req.arguments;
      const prep = await input.hooks?.prepareToolExecution?.({
        ...hookCtxBase,
        args: effectiveArgs,
      });
      if (prep?.updatedArgs !== undefined) effectiveArgs = prep.updatedArgs;
      if (prep?.block === true) {
        return settle(
          { output: prep.reason ?? `Tool call "${req.tool_name}" was blocked`, isError: true },
          effectiveArgs,
        );
      }
      if (prep?.syntheticResult !== undefined) {
        return settle(prep.syntheticResult, effectiveArgs);
      }
      let executionMetadata = prep?.executionMetadata;

      let execution;
      try {
        execution = await tool.resolveExecution(effectiveArgs);
      } catch (error) {
        return settle(
          { output: error instanceof Error ? error.message : String(error), isError: true },
          effectiveArgs,
        );
      }

      if ('isError' in execution && execution.isError === true) {
        return settle(execution, effectiveArgs);
      }
      if (!('execute' in execution)) {
        return settle(
          { output: 'Tool execution resolved without executable', isError: true },
          effectiveArgs,
        );
      }

      const auth = await input.hooks?.authorizeToolExecution?.({
        ...hookCtxBase,
        args: effectiveArgs,
        execution,
      });
      if (auth?.block === true) {
        return settle(
          { output: auth.reason ?? `Tool call "${req.tool_name}" was blocked`, isError: true },
          effectiveArgs,
        );
      }
      if (auth?.syntheticResult !== undefined) {
        return settle(auth.syntheticResult, effectiveArgs);
      }
      executionMetadata = auth?.executionMetadata ?? executionMetadata;

      await emitCall(effectiveArgs);

      let rawResult: { output: unknown; isError?: boolean | undefined; note?: string | undefined };
      try {
        rawResult = await execution.execute({
          turnId: req.turn_id,
          toolCallId,
          metadata: executionMetadata,
          signal: input.signal,
        });
      } catch (error) {
        rawResult = {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      const finalized =
        (await input.hooks?.finalizeToolResult?.({
          ...hookCtxBase,
          args: effectiveArgs,
          result: rawResult as never,
        })) ?? rawResult;

      return settle(finalized, effectiveArgs);
    };

    // ── Tool lifecycle hooks (new: Rust tool_call.rs -> JS) ──────────────
    const prepareToolHandler = async (
      req: PrepareToolRequest,
    ): Promise<PrepareToolResponse | null> => {
      if (!input.hooks?.prepareToolExecution) return null;
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const tool = stepTools.find((t) => t.name === req.tool_name);
      const toolCall: { id: string; name: string; arguments: string; type: 'function' } = {
        id: req.tool_call_id,
        name: req.tool_name,
        arguments:
          typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? {}),
        type: 'function',
      };
      try {
        const result = await input.hooks.prepareToolExecution({
          toolCall,
          toolCalls: [toolCall],
          tool,
          args: req.arguments,
          turnId: input.turnId,
          stepNumber: req.step_number,
          traceId: req.trace_id,
          signal: input.signal,
          llm: input.llm,
        });
        if (!result) return null;
        if (result.block) {
          return { block: true, reason: result.reason, resolved: true };
        }
        if (result.syntheticResult) {
          return {
            block: false,
            synthetic_result: {
              content: outputToContent(result.syntheticResult.output),
              is_error: result.syntheticResult.isError === true,
              stop_turn: result.syntheticResult.stopTurn === true,
              is_prediction: false,
            },
            updated_args: result.updatedArgs,
            execution_metadata: result.executionMetadata,
            resolved: true,
          };
        }
        return {
          block: false,
          updated_args: result.updatedArgs,
          execution_metadata: result.executionMetadata,
          resolved: true,
        };
      } catch {
        return null;
      }
    };

    const authorizeToolHandler = async (
      req: AuthorizeToolRequest,
    ): Promise<AuthorizeToolResponse | null> => {
      if (!input.hooks?.authorizeToolExecution) return null;
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const tool = stepTools.find((t) => t.name === req.tool_name);
      const toolCall: { id: string; name: string; arguments: string; type: 'function' } = {
        id: req.tool_call_id,
        name: req.tool_name,
        arguments:
          typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? {}),
        type: 'function',
      };
      try {
        const result = await input.hooks.authorizeToolExecution({
          toolCall,
          toolCalls: [toolCall],
          tool,
          args: req.arguments,
          turnId: input.turnId,
          stepNumber: req.step_number,
          traceId: req.trace_id,
          signal: input.signal,
          llm: input.llm,
          execution: {
            approvalRule: req.approval_rule,
            execute: async () => ({ output: '', isError: false }),
            accesses: undefined as never,
          },
        });
        if (!result) return null;
        if (result.block) {
          return { block: true, reason: result.reason, resolved: true };
        }
        if (result.syntheticResult) {
          return {
            block: false,
            synthetic_result: {
              content: outputToContent(result.syntheticResult.output),
              is_error: result.syntheticResult.isError === true,
              stop_turn: result.syntheticResult.stopTurn === true,
              is_prediction: false,
            },
            execution_metadata: result.executionMetadata,
            resolved: true,
          };
        }
        return { block: false, execution_metadata: result.executionMetadata, resolved: true };
      } catch {
        return null;
      }
    };

    const finalizeToolHandler = async (req: FinalizeToolRequest): Promise<FinalizeToolResponse> => {
      if (!input.hooks?.finalizeToolResult) return null;
      const toolCall: { id: string; name: string; arguments: string; type: 'function' } = {
        id: req.tool_call_id,
        name: req.tool_name,
        arguments:
          typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? {}),
        type: 'function',
      };
      try {
        const result = await input.hooks.finalizeToolResult({
          toolCall,
          toolCalls: [toolCall],
          args: req.arguments,
          result: req.result as never,
          turnId: input.turnId,
          stepNumber: req.step_number,
          traceId: req.trace_id,
          signal: input.signal,
          llm: input.llm,
        });
        if (!result) return null;
        return {
          content: outputToContent(result.output),
          is_error: result.isError === true,
          note: result.note,
          is_prediction: false,
          stop_turn: result.stopTurn === true,
        };
      } catch {
        return null;
      }
    };

    // ── Drive the turn ────────────────────────────────────────────────
    // In host-proxy mode, message content and the tool table are NOT sent:
    // the host rebuilds both from `context` on every host/llm_chat callback
    // (the source of truth), so Rust only needs metadata to drive control
    // flow. In native LLM mode, Rust calls the provider itself, so the
    // history and tool schemas are serialized at the start of every drive
    // (re-serialized on each continuation so flushed steer messages are
    // included) and progress flows back over the event channel.
    const runRustOnce = async (maxSteps: number): Promise<RunTurnResult> => {
      const wireMessages = nativeLlm === undefined ? [] : await buildWireMessages();
      const wireTools = nativeLlm === undefined ? [] : buildWireTools();
      if (mode === 'napi') {
        const engine = getNapiEngine();
        if (engine === null) throw new Error('napi engine not initialized');
        // Napi callbacks use JSON-serialized payloads (string → string)
        const napiResult = await engine.runTurn(
          {
            turnId: input.turnId,
            systemPrompt: input.llm.systemPrompt,
            modelName: input.llm.modelName,
            messages: wireMessages.map((m) => ({
              role: m.role,
              content: m.content,
              blocksJson: m.blocks === undefined ? undefined : JSON.stringify(m.blocks),
              toolCallsJson: m.tool_calls === undefined ? undefined : JSON.stringify(m.tool_calls),
              toolCallId: m.tool_call_id,
            })),
            tools: wireTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: JSON.stringify(t.parameters ?? {}),
            })),
            maxSteps,
            nativeLlm:
              nativeLlm === undefined
                ? undefined
                : {
                    protocol: nativeLlm.protocol,
                    apiKey: nativeLlm.api_key,
                    baseUrl: nativeLlm.base_url,
                    model: nativeLlm.model,
                    maxTokens: nativeLlm.max_tokens,
                  },
            workspaceRoot,
            nativeTools,
          },
          // Wrap structured handler with JSON serialization for napi
          async (_requestJson: string) => {
            const response = await llmChatHandler();
            return JSON.stringify(response);
          },
          async (requestJson: string) => {
            const req = JSON.parse(requestJson) as ToolExecuteRequest;
            const response = await toolExecuteHandler(req);
            return JSON.stringify(response);
          },
          handleEngineEvent,
          {
            // Tool-lifecycle channels (JSON ↔ JSON): reuse the same typed
            // handlers as the stdio transport, so napi write-class tools run
            // behind the identical prepare/authorize/finalize gate.
            prepareTool: async (requestJson: string) =>
              JSON.stringify(
                await prepareToolHandler(JSON.parse(requestJson) as PrepareToolRequest),
              ),
            authorizeTool: async (requestJson: string) =>
              JSON.stringify(
                await authorizeToolHandler(JSON.parse(requestJson) as AuthorizeToolRequest),
              ),
            finalizeTool: async (requestJson: string) =>
              JSON.stringify(
                await finalizeToolHandler(JSON.parse(requestJson) as FinalizeToolRequest),
              ),
          },
        );
        return {
          stop_reason: napiResult.stopReason,
          steps: napiResult.steps,
          usage: {
            input_tokens: napiResult.inputTokens,
            output_tokens: napiResult.outputTokens,
            total_tokens: napiResult.totalTokens,
          },
        };
      }
      // stdio JSON-RPC path
      const agent = getAgent();
      if (agent === null) throw new Error('stdio agent process not initialized');
      agent.setLlmChatHandler(llmChatHandler);
      agent.setToolExecuteHandler(toolExecuteHandler);
      agent.setPrepareToolHandler(prepareToolHandler);
      agent.setAuthorizeToolHandler(authorizeToolHandler);
      agent.setFinalizeToolHandler(finalizeToolHandler);
      agent.setEventHandler(handleEngineEvent);

      const result = await agent.request('agent/run_turn', {
        turn_id: input.turnId,
        system_prompt: input.llm.systemPrompt,
        model_name: input.llm.modelName,
        messages: wireMessages,
        tools: wireTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters ?? {},
        })),
        max_steps: maxSteps,
        providers: providers ?? [],
        native_llm: nativeLlm,
        workspace_root: workspaceRoot,
        native_tools: nativeTools,
      });
      if (!result) {
        throw new Error('Rust engine returned null result');
      }
      return result as RunTurnResult;
    };

    // ── Abort propagation ───────────────────────────────────────
    // `requestEngineCancel` (above) sets the engine's per-turn cancellation
    // flag, checked before every Rust step. The synthetic-stop
    // short-circuits in the llm/tool handlers additionally end host-proxy
    // turns at the very next callback. An in-flight provider request still
    // finishes its step; the flag takes effect at the following boundary.
    const onAbort = (): void => {
      requestEngineCancel(input.turnId);
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    // ── Continuation loop ───────────────────────────────────────
    // Mirrors the JS loop's `shouldContinueAfterStop`: after the Rust drive
    // stops, the host hook flushes buffered steer messages and decides
    // whether the model gets another step to react (steer follow-up, goal
    // outcome message, Stop-hook continuation). Each granted continuation
    // re-drives the Rust engine with the remaining step budget.
    const maxStepsBudget = input.maxSteps ?? 10;
    let totalSteps = 0;
    const usageTotal = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let stopReason = mapStopReason('EndTurn');
    try {
      while (!input.signal.aborted) {
        const remaining = maxStepsBudget - totalSteps;
        if (remaining <= 0) break;
        const rustResult = await runRustOnce(remaining);
        totalSteps += rustResult.steps;
        usageTotal.input_tokens += rustResult.usage.input_tokens ?? 0;
        usageTotal.output_tokens += rustResult.usage.output_tokens ?? 0;
        usageTotal.total_tokens += rustResult.usage.total_tokens ?? 0;
        stopReason = mapStopReason(rustResult.stop_reason);
        if (stopReason === 'aborted' && !input.signal.aborted && stopTurnRequested) {
          // The engine aborted because the host asked it to stop after a
          // hard per-step limit (goal budget → cancel_turn on the stdio
          // native-LLM path), not because the user cancelled. Report the
          // natural end so the caller applies budget semantics — mapping
          // this to 'aborted' would pause the goal as user-interrupted.
          stopReason = mapStopReason('EndTurn');
        }
        if (input.signal.aborted || stopReason === 'aborted') break;
        const continuation = await input.hooks?.shouldContinueAfterStop?.({
          turnId: input.turnId,
          stepNumber: currentStep,
          usage: lastStepUsage,
          stopReason: stopReason as never,
          signal: input.signal,
          llm: input.llm,
        });
        if (continuation?.continue !== true) break;
        // A granted continuation explicitly allows further steps (the hook
        // itself refuses while an active goal is over budget), so clear the
        // per-step hard-stop latch before re-driving.
        stopTurnRequested = false;
      }
    } catch (error) {
      // A cancel can surface as an error from the transport (rejected
      // callback, RPC failure after cancel_turn). Report it as an aborted
      // turn — not a failed one — so the caller maps it to 'cancelled' and a
      // running goal pauses as interrupted instead of errored.
      if (!input.signal.aborted) {
        // Loop-parity diagnostics: the JS loop reports abnormal endings via
        // `turn.interrupted` with step detail (run-turn.ts). Aborts are
        // deliberately NOT reported here — the host synthesizes the
        // interrupt with the correct user_cancelled attribution when no
        // loop event arrived (turn/index.ts fallback).
        void input.dispatchEvent({
          type: 'turn.interrupted',
          reason: 'error',
          attemptedSteps: currentStep,
          activeStep: currentStep,
          message: error instanceof Error ? error.message : String(error),
          interruptReason: 'error',
        } as never);
        throw error;
      }
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      // Flush queued engine events before closing the last step so the
      // transcript records deltas/tool results in order.
      await eventChain.catch(() => {});
      await closeOpenStep();
    }
    if (input.signal.aborted) {
      stopReason = mapStopReason('Aborted');
    }

    return {
      stopReason,
      steps: totalSteps,
      usage: {
        inputOther: usageTotal.input_tokens,
        output: usageTotal.output_tokens,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    };
  };
}

/**
 * Map Rust-style stop reason to JS LoopTurnStopReason.
 */
export function mapStopReason(
  reason: string,
): Awaited<ReturnType<import('@moonshot-ai/agent-core').RunTurnOverride>>['stopReason'] {
  switch (reason) {
    case 'EndTurn':
      return 'end_turn' as never;
    case 'MaxTokens':
      return 'max_tokens' as never;
    case 'Filtered':
      return 'filtered' as never;
    case 'Paused':
      return 'paused' as never;
    case 'Aborted':
      return 'aborted' as never;
    case 'BudgetLimited':
      return 'budget_limited' as never;
    default:
      return 'unknown' as never;
  }
}

/**
 * Try to parse a JSON string into a value. Returns the original string if parsing fails.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function isRustEngineAvailable(): boolean {
  return NapiEngine.isAvailable() || AgentProcess.findBinary() !== null;
}

/**
 * Which transport the Rust engine selected. Reports `'js'` until the first
 * `createRunTurnOverride`/`runTurnRust` call initializes the engine — it
 * never triggers initialization itself, so it is safe to call for logging.
 */
export function getRustEngineMode(): 'napi' | 'stdio' | 'js' {
  return engineMode;
}

export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
  napiEngine = null;
  engineMode = 'js';
}

// ── Session-owned agent API (phase D thin-client protocol, stdio only) ─────
// The Rust engine owns sessions, agents, goal driving, and persistence;
// this side only installs `host/*` handlers (LLM + tool lifecycle) and
// renders. Every call returns null when the stdio engine is unavailable.

export interface SessionHostHandlers {
  llmChat: (req: LlmChatRequest) => Promise<LlmChatResponse>;
  toolExecute: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>;
  prepareTool?: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>;
  authorizeTool?: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>;
  finalizeTool?: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>;
  onEvent?: (event: EngineEvent) => void;
}

/** Install the host callback handlers a session-owned agent calls back on. */
export function installSessionHostHandlers(handlers: SessionHostHandlers): boolean {
  const agent = getAgent();
  if (!agent) return false;
  agent.setLlmChatHandler(handlers.llmChat);
  agent.setToolExecuteHandler(handlers.toolExecute);
  if (handlers.prepareTool) agent.setPrepareToolHandler(handlers.prepareTool);
  if (handlers.authorizeTool) agent.setAuthorizeToolHandler(handlers.authorizeTool);
  if (handlers.finalizeTool) agent.setFinalizeToolHandler(handlers.finalizeTool);
  if (handlers.onEvent) agent.setEventHandler(handlers.onEvent);
  return true;
}

/** A host-resolved MCP server definition for the session path. The host reads
 *  config + secrets (e.g. the bearer token from its env var) and hands the
 *  engine a flat spec; the engine connects it into the session's runtime. */
export interface McpServerInput {
  name: string;
  /** 'stdio' | 'sse' | 'http'. Inferred from command/url when omitted. */
  transport?: 'stdio' | 'sse' | 'http';
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  enabledTools?: string[];
  disabledTools?: string[];
  /** Remote: pre-resolved static bearer token. */
  bearerToken?: string;
  bearerTokenEnvVar?: string;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  hasHeaders?: boolean;
  /** From an untrusted `<repoRoot>/.mcp.json` (held for approval). */
  projectRoot?: boolean;
}

/** Map the camelCase host spec onto the engine's snake_case wire shape. */
function toMcpServerWire(s: McpServerInput): Record<string, unknown> {
  return {
    name: s.name,
    transport: s.transport,
    enabled: s.enabled,
    command: s.command,
    args: s.args ?? [],
    env: s.env,
    cwd: s.cwd,
    url: s.url,
    enabled_tools: s.enabledTools,
    disabled_tools: s.disabledTools,
    bearer_token: s.bearerToken,
    bearer_token_env_var: s.bearerTokenEnvVar,
    startup_timeout_ms: s.startupTimeoutMs,
    tool_timeout_ms: s.toolTimeoutMs,
    has_headers: s.hasHeaders,
    project_root: s.projectRoot,
  };
}

/** A host-discovered skill for the session's registry (native `Skill` tool). */
export interface SkillInput {
  name: string;
  description?: string;
  /** 'prompt' | 'workflow' | 'command' | … (defaults to 'prompt' engine-side). */
  skillType?: string;
  source?: string;
  path?: string;
  dir?: string;
  /** Inline skill body; when present, activation uses it instead of the path. */
  content?: string;
}

/** Map the camelCase skill spec onto the engine's snake_case wire shape. */
function toSkillWire(s: SkillInput): Record<string, unknown> {
  return {
    name: s.name,
    description: s.description,
    skill_type: s.skillType,
    source: s.source,
    path: s.path,
    dir: s.dir,
    content: s.content,
  };
}

/**
 * A host-resolved external lifecycle hook for the session (config.toml
 * `[[hooks]]` + plugin contributions). The engine executes these natively:
 * PreToolUse/PostToolUse on its tool chain, UserPromptSubmit/Stop at the
 * prompt boundary.
 */
export interface HookDefInput {
  /** Lifecycle event name, e.g. 'PreToolUse' (TS `HookEventType`). */
  event: string;
  /** Optional regex matched against the tool name / prompt text. */
  matcher?: string;
  /** Shell command; receives the snake_case JSON payload on stdin. */
  command: string;
  /** Timeout in seconds (engine default 30, cap 600). */
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/** Hook wire shape — field names already match the engine's serde form. */
function toHookWire(h: HookDefInput): Record<string, unknown> {
  return {
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeout: h.timeout,
    cwd: h.cwd,
    env: h.env,
  };
}

export interface SessionCreateOptions {
  sessionId?: string;
  homedir?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  goalEnabled?: boolean;
  nativeLlm?: NativeLlmDef;
  /** Host tool definitions presented to the model (executed at the host). */
  tools?: { name: string; description: string; inputSchema?: unknown }[];
  /** MCP servers to register into the session's runtime (engine-native). */
  mcpServers?: McpServerInput[];
  /** Skills to register into the session's registry (native `Skill` tool). */
  skills?: SkillInput[];
  /** External lifecycle hooks the engine executes natively. */
  hooks?: HookDefInput[];
  /**
   * Workspace trust (upstream #2453): when true, stdio MCP servers from the
   * repo's own `.mcp.json` connect immediately instead of being held in
   * `pending-approval`. Defaults to false (untrusted).
   */
  workspaceTrusted?: boolean;
}

/** Create a session-owned agent inside the engine. */
export async function sessionCreate(
  options: SessionCreateOptions = {},
): Promise<{ session_id: string } | null> {
  return agentCall('session/create', {
    session_id: options.sessionId,
    homedir: options.homedir,
    system_prompt: options.systemPrompt,
    provider: options.provider,
    model: options.model,
    goal_enabled: options.goalEnabled,
    native_llm: options.nativeLlm,
    tools: (options.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ?? { type: 'object' },
    })),
    mcp_servers: (options.mcpServers ?? []).map(toMcpServerWire),
    skills: (options.skills ?? []).map(toSkillWire),
    hooks: (options.hooks ?? []).map(toHookWire),
    workspace_trusted: options.workspaceTrusted ?? false,
  });
}

export interface SessionPromptResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/**
 * Run a prompt on a session-owned agent. Goal-aware: continuation turns run
 * inside the engine while a goal stays active.
 */
export async function sessionPrompt(
  sessionId: string,
  input: { type: 'text'; text: string }[],
  agentId?: string,
): Promise<SessionPromptResult | null> {
  return agentCall('session/prompt', {
    session_id: sessionId,
    input,
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
  });
}

/** Spawn a side-question ("between turns") subagent (SDK `startBtw` parity). */
export async function sessionStartBtw(
  sessionId: string,
): Promise<{ btw_id: string } | null> {
  return agentCall('session/start_btw', { session_id: sessionId });
}

/** Destroy the active side-question subagent. */
export async function sessionEndBtw(
  sessionId: string,
): Promise<{ ended: boolean } | null> {
  return agentCall('session/end_btw', { session_id: sessionId });
}

/** Cancel a session's running turn (stops at the next step boundary). */
export async function sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null> {
  return agentCall('session/cancel', { session_id: sessionId });
}

/** Switch the session's model from the next turn onward (native-LLM: updates
 *  the transport model; also updates the config alias). */
export async function sessionSetModel(
  sessionId: string,
  model: string,
): Promise<{ ok: boolean } | null> {
  return agentCall('session/set_model', { session_id: sessionId, model });
}

/** Run a user-initiated `!` shell command natively (silent). `unavailable`
 *  true means no native shell — the host should run it instead. */
export async function sessionRunShell(
  sessionId: string,
  command: string,
  timeoutS?: number,
  commandId?: string,
): Promise<{ output: string | null; is_error: boolean; unavailable?: boolean } | null> {
  return agentCall('session/run_shell', {
    session_id: sessionId,
    command,
    timeout_s: timeoutS,
    command_id: commandId,
  });
}

/** Cancel a streaming `!` shell command by its commandId (SDK
 *  `cancelShellCommand` parity). */
export async function sessionCancelShellCommand(
  sessionId: string,
  commandId: string,
): Promise<{ cancelled: boolean } | null> {
  return agentCall('session/cancel_shell_command', {
    session_id: sessionId,
    command_id: commandId,
  });
}

/** Set reasoning effort ("low"|"medium"|"high"; null clears) from the next
 *  turn. Native-LLM OpenAI: becomes the request's `reasoning_effort`. */
export async function sessionSetThinking(
  sessionId: string,
  effort: string | null,
): Promise<{ ok: boolean } | null> {
  return agentCall('session/set_thinking', { session_id: sessionId, effort });
}

/** Queue steer input for the session; drained at the start of the next turn
 *  (including a goal-continuation turn). `queued` false = unknown session. */
export async function sessionSteer(
  sessionId: string,
  input: { type: 'text'; text: string }[],
): Promise<{ queued: boolean } | null> {
  return agentCall('session/steer', { session_id: sessionId, input });
}

/** Add an additional directory to the session's workspace allowlist.
 *  Returns the updated list of additional dirs. */
export async function sessionAddAdditionalDir(
  sessionId: string,
  path: string,
): Promise<{ success: boolean; additional_dirs: string[] } | null> {
  return agentCall('session/add_additional_dir', { session_id: sessionId, path });
}

/** Remove an additional directory from the session's workspace allowlist.
 *  Returns the updated list of additional dirs. */
export async function sessionRemoveAdditionalDir(
  sessionId: string,
  path: string,
): Promise<{ success: boolean; additional_dirs: string[] } | null> {
  return agentCall('session/remove_additional_dir', { session_id: sessionId, path });
}

/** Shallow-merge a JSON object into the session's custom metadata. */
export async function sessionUpdateMetadata(
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<{ ok: boolean; metadata: Record<string, unknown> } | null> {
  return agentCall('session/update_metadata', { session_id: sessionId, metadata });
}

/** Engine goal snapshot (serde form of the Rust `GoalSnapshot`). */
export interface EngineGoalSnapshot {
  goal_id: string;
  objective: string;
  status: string;
  [key: string]: unknown;
}

/** Create (or with `replace` swap) the session goal as the user. */
export async function sessionGoalCreate(
  sessionId: string,
  input: { objective: string; completionCriterion?: string; replace?: boolean },
): Promise<EngineGoalSnapshot | null> {
  return agentCall('session/goal_create', {
    session_id: sessionId,
    objective: input.objective,
    completion_criterion: input.completionCriterion,
    replace: input.replace ?? false,
  });
}

/** The current goal record (`{ goal: null }` when none). */
export async function sessionGoalGet(
  sessionId: string,
): Promise<{ goal: EngineGoalSnapshot | null } | null> {
  return agentCall('session/goal_get', { session_id: sessionId });
}

/** Pause the active goal as the user. */
export async function sessionGoalPause(
  sessionId: string,
  reason?: string,
): Promise<EngineGoalSnapshot | null> {
  return agentCall('session/goal_pause', { session_id: sessionId, reason });
}

/** Resume a paused goal as the user. */
export async function sessionGoalResume(
  sessionId: string,
  reason?: string,
): Promise<EngineGoalSnapshot | null> {
  return agentCall('session/goal_resume', { session_id: sessionId, reason });
}

/** Cancel the goal as the user. */
export async function sessionGoalCancel(
  sessionId: string,
): Promise<EngineGoalSnapshot | null> {
  return agentCall('session/goal_cancel', { session_id: sessionId });
}

/**
 * Toggle swarm mode. Entering applies the enter reminder to the session
 * context (except the silent `tool` trigger); one-shot triggers auto-exit
 * after the next prompt. Returns whether the mode is active afterwards.
 */
export async function sessionSetSwarmMode(
  sessionId: string,
  enabled: boolean,
  trigger?: 'manual' | 'task' | 'tool',
): Promise<{ active: boolean } | null> {
  return agentCall('session/set_swarm_mode', {
    session_id: sessionId,
    enabled,
    trigger,
  });
}

/**
 * Toggle plan mode. Entering sets the permission gate's plan context (which
 * activates the plan-guard policies) and injects the plan-mode reminder;
 * re-entering an active plan mode rejects (RPC error). Returns the plan-mode
 * state afterwards.
 */
export async function sessionSetPlanMode(
  sessionId: string,
  enabled: boolean,
): Promise<{ plan_mode: boolean } | null> {
  return agentCall('session/set_plan_mode', { session_id: sessionId, enabled });
}

/** Engine-side context snapshot (serde snake_case wire form). Message fields
 *  stay snake_case; the app layer maps them onto the SDK `AgentContextData`. */
export interface EngineContextData {
  history: Array<Record<string, unknown>>;
  token_count: number;
}

/** Full context snapshot (SDK `getContext` parity). */
export async function sessionGetContext(
  sessionId: string,
): Promise<EngineContextData | null> {
  return agentCall('session/get_context', { session_id: sessionId });
}

/** Clear the session's model context (SDK `clearContext` parity). */
export async function sessionClearContext(
  sessionId: string,
): Promise<{ cleared: boolean } | null> {
  return agentCall('session/clear_context', { session_id: sessionId });
}

/** Append imported transcript text to the context (SDK `importContext`). */
export async function sessionImportContext(
  sessionId: string,
  content: string,
  source: string,
): Promise<{ imported: boolean } | null> {
  return agentCall('session/import_context', {
    session_id: sessionId,
    content,
    source,
  });
}

/**
 * Undo the last `count` user turns (SDK `undoHistory` parity). Rejects (RPC
 * error) when the requested count is not fully available, matching the SDK's
 * throwing contract; the engine leaves the history untouched in that case.
 */
export async function sessionUndoHistory(
  sessionId: string,
  count: number,
): Promise<{ undone_turns: number; cut_index: number | null } | null> {
  return agentCall('session/undo_history', { session_id: sessionId, count });
}

/** Engine-side plan info (serde form of `PlanData`; SDK `PlanInfo` parity). */
export interface EnginePlanInfo {
  id: string;
  content: string;
  path: string;
}

/** Active plan snapshot (SDK `getPlan` parity); null when no plan is active. */
export async function sessionGetPlan(
  sessionId: string,
): Promise<EnginePlanInfo | null> {
  return agentCall('session/get_plan', { session_id: sessionId });
}

/** Clear the active plan's file content (SDK `clearPlan` parity). */
export async function sessionClearPlan(
  sessionId: string,
): Promise<{ cleared: boolean } | null> {
  return agentCall('session/clear_plan', { session_id: sessionId });
}

/**
 * Activate a skill (SDK `activateSkill` parity): the engine renders the skill
 * prompt and runs a turn. Resolves with the turn summary; callers observe the
 * work via `skill.activated` + `turn.*` events on the session stream.
 */
export async function sessionActivateSkill(
  sessionId: string,
  name: string,
  args?: string,
): Promise<{ stop_reason: string; steps: number } | null> {
  return agentCall('session/activate_skill', {
    session_id: sessionId,
    name,
    args,
  });
}

/** Reconnect a single MCP server (SDK `reconnectMcpServer` parity). */
export async function sessionReconnectMcpServer(
  sessionId: string,
  name: string,
): Promise<{ name: string; status: string; tool_count: number } | null> {
  return agentCall('session/reconnect_mcp_server', {
    session_id: sessionId,
    name,
  });
}

/** MCP startup timing (SDK `getMcpStartupMetrics` parity). */
export async function sessionGetMcpStartupMetrics(
  sessionId: string,
): Promise<{ duration_ms: number } | null> {
  return agentCall('session/get_mcp_startup_metrics', { session_id: sessionId });
}

/** Generate AGENTS.md via an init subagent (SDK `Session.init` parity). */
export async function sessionInit(sessionId: string): Promise<{ ok: boolean } | null> {
  return agentCall('session/init', { session_id: sessionId });
}

/** Engine-side persisted session record (serde snake_case; SDK `SessionSummary` parity subset). */
export interface EngineSessionRecord {
  id: string;
  created_at: string;
  updated_at: string;
  title?: string;
  work_dir?: string;
}

/** Engine-side session status snapshot (serde snake_case wire form). */
export interface EngineSessionStatus {
  model?: string | null;
  thinking_effort: string;
  permission: 'manual' | 'auto' | 'yolo';
  plan_mode: boolean;
  swarm_mode: boolean;
  goal_enabled: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
  usage?: {
    by_model?: Record<string, { input_tokens: number; output_tokens: number; total_tokens: number }>;
    total?: { input_tokens: number; output_tokens: number; total_tokens: number };
    current_turn?: { input_tokens: number; output_tokens: number; total_tokens: number };
  } | null;
}

/** Live status snapshot (SDK `getStatus` parity). */
export async function sessionGetStatus(
  sessionId: string,
): Promise<EngineSessionStatus | null> {
  return agentCall('session/get_status', { session_id: sessionId });
}

/** Engine-side per-server MCP view (SDK `McpServerInfo` parity). */
export interface EngineMcpServerInfo {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  status: 'pending' | 'pending-approval' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  tool_count: number;
  error?: string | null;
}

/** Per-server MCP views (SDK `listMcpServers` parity). */
export async function sessionListMcpServers(
  sessionId: string,
): Promise<{ servers: EngineMcpServerInfo[] } | null> {
  return agentCall('session/list_mcp_servers', { session_id: sessionId });
}

/** Engine-side registered skill (serde snake_case). */
export interface EngineSkillSummary {
  name: string;
  description: string;
  skill_type: string;
  source?: string | null;
  path?: string | null;
  dir?: string | null;
}

/** Registered skills for the session (SDK `listSkills` parity). */
export async function sessionListSkills(
  sessionId: string,
): Promise<{ skills: EngineSkillSummary[] } | null> {
  return agentCall('session/list_skills', { session_id: sessionId });
}

/** Engine-side session warning (SDK `SessionWarning` parity). */
export interface EngineSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

/** Session warnings, e.g. failed MCP servers (SDK `getSessionWarnings` parity). */
export async function sessionGetWarnings(
  sessionId: string,
): Promise<{ warnings: EngineSessionWarning[] } | null> {
  return agentCall('session/get_warnings', { session_id: sessionId });
}

/** Engine-side cumulative usage (serde snake_case; TokenUsage is input_tokens/
 *  output_tokens/total_tokens). Empty object when nothing has accrued. */
export interface EngineSessionUsage {
  by_model?: Record<string, { input_tokens: number; output_tokens: number; total_tokens: number }>;
  total?: { input_tokens: number; output_tokens: number; total_tokens: number };
  current_turn?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/** Cumulative usage snapshot (SDK `getUsage` parity). */
export async function sessionGetUsage(
  sessionId: string,
): Promise<EngineSessionUsage | null> {
  return agentCall('session/get_usage', { session_id: sessionId });
}

/** Manually compact the session context (SDK `compact` parity). Requires a
 *  native-LLM summarizer; rejects (RPC error) without one. */
export async function sessionCompact(
  sessionId: string,
  instruction?: string,
): Promise<{ compacted: boolean; summary?: string; tokens_before?: number; tokens_after?: number } | null> {
  return agentCall('session/compact', { session_id: sessionId, instruction });
}

/** One pending tool approval (web-facing approval surface). */
export interface EngineApprovalEntry {
  id: string;
  session_id?: string | null;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  approval_rule: string;
  created_at_ms: number;
}

/** List pending tool approvals (web approval cards). The session id is
 *  optional: omitted lists approvals across sessions (run_turn path). */
export async function sessionApprovalList(
  sessionId?: string,
): Promise<{ pending: EngineApprovalEntry[] } | null> {
  return agentCall('session/approval_list', (sessionId !== undefined ? { session_id: sessionId } : {}));
}

/** Resolve a pending tool approval (allow/deny). Returns `{ resolved: false }`
 *  for an unknown id. */
export async function sessionApprovalResolve(
  sessionId: string,
  input: { id: string; decision: 'allow' | 'deny'; reason?: string },
): Promise<{ resolved: boolean } | null> {
  return agentCall('session/approval_resolve', {
    session_id: sessionId,
    id: input.id,
    decision: input.decision,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** Persist a session's full state (context history + goal). */
export async function sessionSave(sessionId: string): Promise<{ ok: boolean } | null> {
  return agentCall('session/save', { session_id: sessionId });
}

/** Restore a session's state; an `active` goal comes back `paused`. */
export async function sessionLoad(sessionId: string): Promise<{ found: boolean } | null> {
  return agentCall('session/load', { session_id: sessionId });
}

/** List persisted sessions (most recent first). */
export async function sessionList(
  limit?: number,
  offset?: number,
): Promise<{ sessions: EngineSessionRecord[] } | null> {
  return agentCall('session/list', { limit, offset });
}

// ── Session client (host-facing wrapper over the session surface) ────────

/** A host tool exposed to a session-owned agent. */
export interface SessionToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments (defaults to an open object). */
  inputSchema?: unknown;
  execute: (args: unknown) => Promise<{ output: string; isError?: boolean }>;
}

export interface SessionClientOptions {
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  goalEnabled?: boolean;
  homedir?: string;
  nativeLlm?: NativeLlmDef;
  /**
   * Configure the engine's native permission gate for this session. `auto` /
   * `yolo` let the engine approve gated tool calls locally (no host authorize
   * round-trip); `manual` keeps interactive approval on the host. When unset,
   * the gate keeps its startup mode (`KIMI_PERMISSION_MODE`, default manual).
   */
  permissionMode?: NativePermissionMode;
  /** MCP servers to register into the session's runtime (host-resolved). */
  mcpServers?: McpServerInput[];
  /** Skills to register into the session's registry (native `Skill` tool). */
  skills?: SkillInput[];
  /** External lifecycle hooks the engine executes natively. */
  hooks?: HookDefInput[];
  /**
   * Answer one model step (host-proxy mode): given the engine's wire-shaped
   * request, return the model reply. Unused when `nativeLlm` is set — the
   * engine then talks to the provider directly and streams deltas back over
   * `onEvent`.
   */
  llmStep?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
  /** Host tools the engine may call back for. */
  tools?: SessionToolDef[];
  /** Lifecycle + streaming events (`session.*`, `llm.*`). */
  onEvent?: (event: EngineEvent) => void;
  /**
   * Tool-lifecycle handlers (the approval gate) for engine-native
   * write-class tools. Without them such tools fall back to full host
   * execution or fail closed — provide at least `authorizeTool` when the
   * engine runs native Write/Edit/Bash.
   */
  lifecycle?: {
    prepareTool?: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>;
    authorizeTool?: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>;
    finalizeTool?: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>;
  };
}

/**
 * A session-owned agent handle: the ENGINE owns the loop, context, goal
 * driving, and persistence — the host only answers model steps and tool
 * calls, and renders from events. This is the phase-D integration point for
 * hosts (print mode, TUI): hand it a step function and a tool table instead
 * of running a turn loop.
 */
export interface SessionClient {
  readonly sessionId: string;
  /** Run one prompt; goal continuations run inside the engine. */
  prompt(text: string, agentId?: string): Promise<SessionPromptResult | null>;
  /** Stop the running prompt at the next step boundary. */
  cancel(): Promise<boolean>;
  /** Persist context + goal under this session id. */
  save(): Promise<boolean>;
  /** Restore persisted state; an active goal comes back paused. */
  load(): Promise<boolean>;
  /** Spawn a side-question ("between turns") subagent; returns its id. */
  startBtw?(): Promise<string | null>;
  /** Destroy the active side-question subagent. */
  endBtw?(): Promise<boolean>;
  /** Release this client's host-callback registration (multi-session hosts). */
  close?(): void;
}

/**
 * Create a session-owned agent and install the host handlers for it.
 * Returns null when the stdio engine is unavailable (the session surface is
 * stdio-only; set KIMI_AGENT_FORCE_STDIO=1 to skip a present napi addon).
 *
 * NOTE: host handlers live on the engine-process singleton, so one session
 * client is active at a time — same constraint as the turn-override path.
 */
export async function createSessionClient(
  options: SessionClientOptions,
): Promise<SessionClient | null> {
  if (initEngine() !== 'stdio') return null;
  const created = await sessionCreate({
    sessionId: options.sessionId,
    homedir: options.homedir,
    systemPrompt: options.systemPrompt,
    model: options.model,
    goalEnabled: options.goalEnabled,
    nativeLlm: options.nativeLlm,
    tools: (options.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    mcpServers: options.mcpServers,
    skills: options.skills,
    hooks: options.hooks,
  });
  if (created === null) return null;
  const sessionId = created.session_id;

  // Configure the process-wide native gate for this session so gated tool
  // approval matches the host's intent (e.g. print mode → auto, no host
  // authorize round-trip). Best-effort: a failure leaves the startup mode.
  if (options.permissionMode !== undefined) {
    await permissionSetMode(options.permissionMode);
  }

  const toolMap = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const handlers: SessionHostHandlers = {
    llmChat:
      options.llmStep ??
      (() =>
        Promise.reject(
          new Error('createSessionClient: llmStep is required in host-proxy mode'),
        )),
    toolExecute: async (req) => {
      const tool = toolMap.get(req.tool_name);
      if (tool === undefined) {
        return { content: `Tool "${req.tool_name}" not found`, is_error: true };
      }
      try {
        const result = await tool.execute(req.arguments);
        return { content: result.output, is_error: result.isError === true };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        };
      }
    },
    onEvent: options.onEvent,
    prepareTool: options.lifecycle?.prepareTool,
    authorizeTool: options.lifecycle?.authorizeTool,
    finalizeTool: options.lifecycle?.finalizeTool,
  };
  // Multi-session routing: register under this session id so the engine's
  // session-stamped host callbacks (and events) land on this client even
  // when other sessions share the engine process.
  const agent = getAgent();
  if (agent === null) {
    return null;
  }
  agent.registerSessionHandlers(sessionId, handlers);

  return {
    sessionId,
    prompt: (text, agentId) =>
      sessionPrompt(sessionId, [{ type: 'text', text }], agentId),
    cancel: async () => (await sessionCancel(sessionId))?.cancelled ?? false,
    save: async () => (await sessionSave(sessionId))?.ok ?? false,
    load: async () => (await sessionLoad(sessionId))?.found ?? false,
    startBtw: async () => (await sessionStartBtw(sessionId))?.btw_id ?? null,
    endBtw: async () => (await sessionEndBtw(sessionId))?.ended ?? false,
    close: () => {
      agent.unregisterSessionHandlers(sessionId);
    },
  };
}

// ── Cron RPC API ──────────────────────────────────────────────────────────────

export interface CronCreateResult {
  id: string;
  cron: string;
  prompt: string;
  created_at: number;
  recurring: boolean;
}

export interface CronTaskSnapshot {
  id: string;
  cron: string;
  recurring: boolean;
  created_at: number;
  last_fired_at?: number;
  next_fire_at?: number;
}

export interface CronListResult {
  tasks: CronTaskSnapshot[];
}

export interface CronDeleteResult {
  removed: string[];
}

export interface CronGetNextFireResult {
  next_fire_at?: number;
}

/**
 * Send a JSON-RPC request to the Rust agent (stdio or napi).
 * Falls back to `null` when the Rust engine is not available.
 */
async function agentCall<T = unknown>(method: string, params: unknown): Promise<T | null> {
  const mode = initEngine();
  if (mode === 'stdio') {
    const agent = getAgent();
    if (!agent) return null;
    return (await agent.request(method, params)) as T;
  }
  if (mode === 'napi') {
    // Napi mode: use the napi engine's RPC-like direct call.
    // The napi bridge currently only supports runTurnRust; for generic
    // RPC we fall through to stdio. If the napi engine is loaded but
    // no stdio binary is available, cron/background calls are not
    // available in pure-napi mode.
    console.warn('[kimi-agent] Napi mode does not support generic RPC; falling back to JS');
    return null;
  }
  return null;
}

/** Create a cron task. Returns null if the Rust engine is not available. */
export async function cronCreate(params: {
  cron: string;
  prompt: string;
  recurring?: boolean;
}): Promise<CronCreateResult | null> {
  return agentCall<CronCreateResult>('cron/create', params);
}

/** Delete cron tasks by id. Returns null if the Rust engine is not available. */
export async function cronDelete(ids: string[]): Promise<CronDeleteResult | null> {
  return agentCall<CronDeleteResult>('cron/delete', { ids });
}

/** List all cron tasks. Returns null if the Rust engine is not available. */
export async function cronList(): Promise<CronListResult | null> {
  return agentCall<CronListResult>('cron/list', {});
}

/** Get next fire time for a cron task. Returns null if the Rust engine is not available. */
export async function cronGetNextFire(taskId?: string): Promise<CronGetNextFireResult | null> {
  return agentCall<CronGetNextFireResult>('cron/get_next_fire', { task_id: taskId });
}

// ── Background task RPC API ───────────────────────────────────────────────────

export interface BgRegisterResult {
  task_id: string | null;
  error?: string | null;
}

export interface BgOutputResult {
  output_path?: string;
  output_size_bytes: number;
  preview_bytes: number;
  truncated: boolean;
  full_output_available: boolean;
  preview: string;
  error?: string;
}

/** Engine plugin summary wire shape (SDK `PluginSummary`; serde snake_case). */
export interface EnginePluginSummary {
  id: string;
  display_name: string;
  version?: string;
  enabled: boolean;
  state: string;
  skill_count: number;
  mcp_server_count: number;
  enabled_mcp_server_count: number;
  hook_count: number;
  command_count: number;
  has_errors: boolean;
  source: string;
}

/** Engine plugin detail wire shape (SDK `PluginInfo`; extends the summary). */
export interface EnginePluginInfo extends EnginePluginSummary {
  root: string;
  installed_at: string;
  mcp_servers: Array<{
    name: string;
    runtime_name: string;
    enabled: boolean;
    transport: string;
    command?: string | null;
    url?: string | null;
  }>;
  diagnostics: Array<{ severity: string; message: string }>;
}

/** List installed plugins (SDK `listPlugins` parity). */
export async function pluginList(): Promise<{ plugins: EnginePluginSummary[] } | null> {
  return agentCall('plugin/list', {});
}

/** Get one installed plugin's detail (SDK `getPluginInfo` parity); null when
 *  the plugin is unknown. */
export async function pluginGet(id: string): Promise<EnginePluginInfo | null> {
  return agentCall('plugin/get', { id });
}

/** Register a background task. Returns null if the Rust engine is not available. */
export async function bgRegister(params: {
  prefix: string;
  kind: 'process' | 'agent' | 'question';
  description: string;
  detached?: boolean;
  timeoutMs?: number;
}): Promise<BgRegisterResult | null> {
  return agentCall<BgRegisterResult>('bg/register', params);
}

/** List all background tasks. Returns null if the Rust engine is not available. */
export async function bgList(): Promise<unknown[] | null> {
  return agentCall<unknown[]>('bg/list', {});
}

/** Get a specific background task. Returns null if the Rust engine is not available. */
export async function bgGet(taskId: string): Promise<unknown> {
  return agentCall('bg/get', { task_id: taskId });
}

/** Stop a background task. Returns null if the Rust engine is not available. */
export async function bgStop(taskId: string, reason?: string): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('bg/stop', { task_id: taskId, reason });
}

/** Detach a background task from its foreground tool call (SDK
 *  `detachBackgroundTask` parity). Returns the task's wire info, or null when
 *  the task id is unknown. */
export async function bgDetach(taskId: string): Promise<Record<string, unknown> | null> {
  return agentCall('bg/detach', { task_id: taskId });
}

/** Get output snapshot for a background task. Returns null if the Rust engine is not available. */
export async function bgOutput(taskId: string): Promise<BgOutputResult | null> {
  return agentCall<BgOutputResult>('bg/output', { task_id: taskId });
}

/** Append output to a background task. Returns null if the Rust engine is not available. */
export async function bgAppendOutput(
  taskId: string,
  chunk: string,
): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('bg/append_output', { task_id: taskId, chunk });
}

/** Settle (mark terminal) a background task. Returns null if the Rust engine is not available. */
export async function bgSettle(
  taskId: string,
  status: string,
  stopReason?: string,
): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('bg/settle', {
    task_id: taskId,
    status,
    stop_reason: stopReason,
  });
}

// ── Permission gate (native) ───────────────────────────────────────────────
//
// Configure the engine's process-wide permission gate at runtime. RUN_TURN and
// every session agent share one gate, so these calls govern the whole engine.
// `null` means the Rust engine is not available (caller keeps the JS gate).

/** Permission mode understood by the native gate. */
export type NativePermissionMode = 'manual' | 'auto' | 'yolo';

/** A native permission rule (snake_case matches the Rust wire). */
export interface NativePermissionRule {
  decision: 'allow' | 'deny' | 'ask';
  scope: 'turn-override' | 'session-runtime' | 'project' | 'user';
  pattern: string;
  reason?: string;
}

/** Snapshot returned by `permission/get`. */
export interface NativePermissionData {
  mode: NativePermissionMode;
  rules: NativePermissionRule[];
}

/** Read the current permission snapshot ({ mode, rules }). */
export async function permissionGet(): Promise<NativePermissionData | null> {
  return agentCall<NativePermissionData>('permission/get', {});
}

/** Set the permission mode. Returns null if the Rust engine is not available. */
export async function permissionSetMode(
  mode: NativePermissionMode,
): Promise<{ ok: boolean; mode: NativePermissionMode } | null> {
  return agentCall<{ ok: boolean; mode: NativePermissionMode }>('permission/set_mode', { mode });
}

/**
 * Add a permission rule (e.g. record a `session-runtime`-scoped approval so a
 * repeated tool call is auto-approved for the rest of the session).
 */
export async function permissionAddRule(
  rule: NativePermissionRule,
): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('permission/add_rule', rule);
}

// ── Workspace prediction ──────────────────────────────────────────────────

/// Maximum file size for which we offer a prediction (100 KB).
/// Larger files skip the fast-path and execute precisely on the first call.
const PREDICTION_MAX_FILE_SIZE = 100 * 1024;

/// Number of preview lines included in the prediction.
const PREDICTION_PREVIEW_LINES = 5;

/**
 * Lightweight workspace file predictor for the Read tool fast-path.
 *
 * Instead of pre-scanning the entire workspace (like the Rust WorkspaceIndex),
 * this class checks individual files on-demand: stat + read first N lines.
 * This avoids the startup cost of building a full index while still
 * providing instant predictions for most Read calls.
 *
 * The prediction includes the first few lines with line numbers and a
 * note that it's a prediction — the precise result will replace it shortly.
 *
 * When the Rust `WorkspaceIndex` has been preheated (via
 * `nativeBuildWorkspaceIndex`), predictions are served from it first —
 * the on-demand JS stat path is only a fallback for files the index
 * missed (e.g. created after the index was built).
 */
export class WorkspacePredictor {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Generate a Read prediction for the given path: an on-demand stat + read
   * of the first N lines.
   *
   * Returns null when:
   *   - The file doesn't exist or is not a regular file
   *   - The file is too large (> 100 KB)
   *   - The file contains NUL bytes (binary)
   *   - fs/stat is not available (sandboxed environment)
   */
  predictRead(path: string): string | null {
    return this.predictReadViaFs(path);
  }

  /**
   * On-demand JS fallback: stat + read first N lines.
   */
  private predictReadViaFs(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = nodeRequire('node:fs') as typeof import('node:fs');

      const resolved = this.resolvePath(path);
      if (resolved === null) return null;

      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) return null;
      if (stat.size > PREDICTION_MAX_FILE_SIZE) return null;
      if (stat.size === 0) return null;

      // Read first N lines
      const fd = fs.openSync(resolved, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, 8192));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const content = buf.subarray(0, bytesRead).toString('utf-8');

        // Binary detection: NUL byte
        if (content.includes('\0')) return null;

        const lines = content.split('\n');
        const previewLines = lines.slice(0, PREDICTION_PREVIEW_LINES);
        const numbered = previewLines
          .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
          .join('\n');

        const lineCount = stat.size > 0 ? this.estimateLineCount(resolved, stat.size) : 0;
        return (
          `cat ${path}  (prediction: ${lineCount} lines, ${stat.size} bytes)\n` +
          `${numbered}\n` +
          `\n[... prediction — precise result loading ...]`
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /**
   * Resolve a path relative to the workspace root.
   * Returns null if the path is outside the workspace.
   */
  private resolvePath(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = nodeRequire('node:path') as typeof import('node:path');
      const resolved = pathMod.isAbsolute(path) ? path : pathMod.resolve(this.root, path);
      return resolved;
    } catch {
      return null;
    }
  }

  /**
   * Quick line count estimate without reading the whole file.
   * Uses the average line length from the preview.
   */
  private estimateLineCount(filePath: string, fileSize: number): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = nodeRequire('node:fs') as typeof import('node:fs');
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(fileSize, 8192));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const sample = buf.subarray(0, bytesRead).toString('utf-8');
        const sampleLines = sample.split('\n').length;
        const avgLineLength = bytesRead / sampleLines;
        return Math.ceil(fileSize / avgLineLength);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 0;
    }
  }
}
