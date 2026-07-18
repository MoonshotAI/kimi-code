/// Rust agent engine adapter.
///
/// When `agent.engine = "rust"` is configured, this module provides
/// a drop-in replacement for the JS turn loop by starting the
/// `kimi-agent` Rust binary as a child process and communicating
/// with it via stdio JSON-RPC.
///
/// If the Rust binary is not found or fails to start, it falls back
/// to the JS implementation automatically.

import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { appRoot } from '../../scripts/native/paths.mjs';

// ── Types matching the Rust agent protocol ─────────────────────────────────

interface RpcMessage {
  jsonrpc: '2.0';
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RunTurnParams {
  turn_id: string;
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
  max_steps?: number;
}

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

interface LlmChatRequest {
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
}

interface LlmChatResponse {
  tool_calls: { id: string; name: string; arguments: unknown }[];
  finish_reason?: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

// ── Agent process manager ──────────────────────────────────────────────────

class AgentProcess {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private ready = false;

  /** Callback for handling host/llm_chat requests from the Rust side. */
  private llmChatHandler: ((req: LlmChatRequest) => Promise<LlmChatResponse>) | null = null;

  setLlmChatHandler(handler: (req: LlmChatRequest) => Promise<LlmChatResponse>) {
    this.llmChatHandler = handler;
  }

  private static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidates = [
      resolve(appRoot, 'packages/kimi-agent/target/release/kimi-agent' + ext),
      resolve(appRoot, 'packages/kimi-agent/target/debug/kimi-agent' + ext),
    ];
    try {
      const fs = require('node:fs');
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
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
      this.process = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        console.error(`[kimi-agent] ${data.toString().trim()}`);
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
    } catch (err) {
      console.warn('[kimi-agent] Failed to start:', err);
      return false;
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as RpcMessage;

        // Case 1: Response to a pending request
        if (msg.id !== undefined && this.pending.has(msg.id as number)) {
          const pending = this.pending.get(msg.id as number)!;
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
          this.pending.delete(msg.id as number);
          continue;
        }

        // Case 2: Request from Rust side (has method + params)
        if (msg.id !== undefined && msg.method && msg.params !== undefined) {
          this.handleHostRequest(msg).catch((err) => {
            console.error('[kimi-agent] Failed to handle host request:', err);
          });
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  private async handleHostRequest(msg: RpcMessage) {
    if (msg.method === 'host/llm_chat') {
      if (this.llmChatHandler) {
        try {
          const result = await this.llmChatHandler(msg.params as LlmChatRequest);
          const response = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result,
          });
          this.process!.stdin!.write(response + '\n');
        } catch (err) {
          const response = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
          this.process!.stdin!.write(response + '\n');
        }
      } else {
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'No LLM chat handler registered' },
        });
        this.process!.stdin!.write(response + '\n');
      }
    } else {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      });
      this.process!.stdin!.write(response + '\n');
    }
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

// ── Singleton process instance ─────────────────────────────────────────────

let agentProcess: AgentProcess | null = null;
let fallbackToJs = false;

function getAgent(): AgentProcess | null {
  if (fallbackToJs) return null;
  if (!agentProcess) {
    agentProcess = new AgentProcess();
    if (!agentProcess.start()) {
      agentProcess = null;
      fallbackToJs = true;
      return null;
    }
  }
  return agentProcess;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runTurnRust(
  params: RunTurnParams,
  llmChatHandler?: (req: LlmChatRequest) => Promise<LlmChatResponse>,
): Promise<RunTurnResult | null> {
  const agent = getAgent();
  if (!agent) return null;

  if (llmChatHandler) {
    agent.setLlmChatHandler(llmChatHandler);
  }

  try {
    const result = await agent.request('agent/run_turn', params);
    return result as RunTurnResult;
  } catch (err) {
    console.error('[kimi-agent] RPC call failed:', err);
    return null;
  }
}

export function isRustEngineAvailable(): boolean {
  return AgentProcess.findBinary() !== null;
}

export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
}