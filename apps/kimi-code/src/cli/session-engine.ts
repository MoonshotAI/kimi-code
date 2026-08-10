/**
 * session-engine.ts — the session-owned engine path for print mode.
 *
 * In `kimi -p "..."` the prompt routes through the engine's session-owned
 * surface instead of the agent-core harness: the Rust engine owns the loop,
 * context, goal driving, and persistence, talks to the provider directly
 * (native-LLM transport), and runs its own native toolset — this side only
 * parses arguments and renders streamed events.
 *
 * Rollout (Track F, print mode): this is now the DEFAULT. It engages whenever a
 * native-LLM-capable provider is configured; set `KIMI_SESSION_ENGINE=0` to opt
 * out. When on but the provider isn't native-LLM-capable, or the engine binary
 * is unavailable, it falls back to the harness — so the flip never hard-breaks.
 *
 * Transport (G-1 `/rust` consumption rewrite, 2026-08-09): the engine runs as
 * a `kimi-server-serve` subprocess (pull-style RPC; events on stderr), not
 * through the retired rust-loop bridge. Print mode is permission `auto`, so
 * the tool approval gate auto-allows; interactive approval UI arrives with the
 * TUI integration.
 */
import type { Event } from './sdk-types-local';
import { loadNativeLlmDef, loadSessionHooks, loadSessionMcpServers, loadSessionSystemPrompt } from './rust-engine';
import { NativeSessionAdapter } from './native-session-adapter';
import { NativeServerClient } from './native-server-client';

interface SessionEngineIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

/** A compact one-line preview of tool arguments for print-mode rendering. */
function previewToolArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  let text: string;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    return '';
  }
  if (text === '' || text === '{}') return '';
  const flat = text.replaceAll(/\s+/g, ' ');
  return flat.length > 80 ? `(${flat.slice(0, 79)}…)` : `(${flat})`;
}

/**
 * Render a translated session event for headless print mode. Assistant text
 * goes to stdout; tool activity goes to stderr so a piped stdout stays clean.
 * `toolNames` carries tool-call-id → name across the started/result pair so the
 * result line can name the tool. Returns the text to write on each stream (if
 * any); goal updates are handled separately via the raw-event tap.
 */
export function formatSessionPrintEvent(
  event: Event,
  toolNames: Map<string, string>,
): { stdout?: string; stderr?: string } {
  switch (event.type) {
    case 'llm.delta': {
      // The local `Event` mirror only carries the routing fields; the payload
      // lives on the engine wire shapes, so narrow via a local cast.
      const part = (event as { part?: { type?: string; text?: string } }).part;
      if (part === undefined || part.type !== 'text' || part.text === undefined) return {};
      return { stdout: part.text };
    }
    case 'session.tool.started': {
      const started = event as {
        tool_call_id?: string;
        tool_name?: string;
        arguments?: unknown;
      };
      toolNames.set(started.tool_call_id ?? '', started.tool_name ?? '');
      return { stderr: `[tool] ${started.tool_name ?? ''}${previewToolArgs(started.arguments)}\n` };
    }
    case 'session.tool.settled': {
      const settled = event as {
        tool_call_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      const name = toolNames.get(settled.tool_call_id ?? '') ?? settled.tool_call_id ?? '';
      if (settled.is_error === true) {
        const firstLine = String(settled.content).split('\n')[0]?.slice(0, 200) ?? '';
        return { stderr: `[tool] ${name} failed: ${firstLine}\n` };
      }
      return { stderr: `[tool] ${name} ok\n` };
    }
    default:
      return {};
  }
}

export interface SessionEnginePromptArgs extends SessionEngineIo {
  prompt: string;
  workDir: string;
  homeDir?: string;
  configPath?: string;
}

/**
 * Whether the session-owned engine is the print-mode default. It is ON unless
 * explicitly opted out with `KIMI_SESSION_ENGINE=0`. When on but no native-LLM
 * provider is configured (or the engine is unavailable), `tryRunSessionEnginePrompt`
 * falls back to the harness — so flipping the default never hard-breaks a run.
 */
export function isSessionEngineEnabled(): boolean {
  return process.env['KIMI_SESSION_ENGINE'] !== '0';
}

/**
 * Try to run the prompt on the session-owned engine. Returns true when the
 * prompt was handled (successfully or not); false means "not applicable —
 * use the normal path" (opted out, no native LLM, or engine unavailable).
 */
export async function tryRunSessionEnginePrompt(
  args: SessionEnginePromptArgs,
): Promise<boolean> {
  if (!isSessionEngineEnabled()) return false;

  const nativeLlm = loadNativeLlmDef(args.homeDir, args.configPath);
  if (nativeLlm === undefined) {
    // No native-LLM-capable provider → silently defer to the harness (this is
    // the default path now, so a missing provider is normal, not an error).
    return false;
  }

  // One server process per print run: it owns the engine, the approval store,
  // and the event stream for the whole prompt.
  let client: NativeServerClient;
  try {
    client = new NativeServerClient();
  } catch {
    args.stderr.write(
      'session engine: kimi-server-serve binary unavailable; falling back to the normal engine.\n',
    );
    return false;
  }

  // Load the user's MCP servers (user-global only — headless runs never
  // auto-start untrusted project stdio commands). The engine connects them
  // into the session so `mcp__*` tools are available natively.
  const mcpServers = await loadSessionMcpServers(args.homeDir, args.workDir);

  // Load external lifecycle hooks (config `[[hooks]]` + plugins). The engine
  // executes them natively — PreToolUse can veto tool calls, Stop can demand
  // a continuation — so hook users keep their guarantees on this path.
  const hooks = await loadSessionHooks(args.homeDir, args.configPath);

  // Assemble the real system prompt (coder profile identity + merged AGENTS.md
  // + cwd listing), matching the harness path. Falls back to a minimal prompt
  // if the profile assembly is unavailable.
  const systemPrompt =
    (await loadSessionSystemPrompt(args.homeDir, args.workDir)) ??
    'You are Kimi Code, an agentic coding assistant running in headless print mode. Answer directly and use tools when needed.';

  let sawText = false;
  const toolNames = new Map<string, string>();
  const adapter = new NativeSessionAdapter({
    client,
    onRawEvent: (raw) => {
      const e = raw as { type?: string; status?: string };
      if (e.type === 'session.goal.updated' && e.status !== undefined && e.status !== 'none') {
        args.stderr.write(`[goal] ${e.status}\n`);
      }
    },
    // Print mode is permission `auto`: no approver is supplied, so the
    // engine's tool gate auto-allows (see NativeSessionAdapter).
  });
  adapter.onEvent((event) => {
    // Native-LLM mode streams provider deltas as assistant text (stdout) and
    // tool activity as diagnostics (stderr); goal updates ride the raw tap.
    const out = formatSessionPrintEvent(event, toolNames);
    if (out.stdout !== undefined) {
      sawText = true;
      args.stdout.write(out.stdout);
    }
    if (out.stderr !== undefined) {
      args.stderr.write(out.stderr);
    }
  });

  try {
    const started = await adapter.start({
      sessionId: `print-${String(Date.now())}`,
      systemPrompt,
      model: nativeLlm.model,
      goalEnabled: true,
      homedir: args.workDir,
      nativeLlm,
      mcpServers,
      hooks,
      // Print mode is permission `auto`: configure the native gate so gated
      // tools (write/bash) are approved locally, with no host authorize
      // round-trip — the headless run needs no interactive approver.
      permissionMode: 'auto',
    });
    if (!started) {
      args.stderr.write(
        'session engine: engine unavailable; falling back to the normal engine.\n',
      );
      return false;
    }

    const outcome = await adapter.prompt(args.prompt);
    if (outcome === null) {
      args.stderr.write('session engine: prompt failed\n');
      return true; // handled (as a failure) — do not double-run on the fallback
    }
    if (sawText) args.stdout.write('\n');
    args.stderr.write(
      `[session-engine] stop=${outcome.stopReason} steps=${String(outcome.steps)} tokens=${String(outcome.totalTokens)}\n`,
    );
    await adapter.save();
    return true;
  } finally {
    client.close();
  }
}
