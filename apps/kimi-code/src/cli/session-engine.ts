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
 * Boundaries (deliberate):
 * - Print mode is permission `auto`, so the tool approval gate auto-allows;
 *   interactive approval UI arrives with the TUI integration.
 */
import { loadNativeLlmDef, loadSessionHooks, loadSessionMcpServers, loadSessionSystemPrompt } from './rust-engine';
import { SessionEngineController } from './session-engine-controller';
import type { Event } from '@moonshot-ai/kimi-code-sdk';

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
    case 'assistant.delta':
      return { stdout: event.delta };
    case 'tool.call.started': {
      toolNames.set(event.toolCallId, event.name);
      return { stderr: `[tool] ${event.name}${previewToolArgs(event.args)}\n` };
    }
    case 'tool.result': {
      const name = toolNames.get(event.toolCallId) ?? event.toolCallId;
      if (event.isError) {
        const firstLine = String(event.output).split('\n')[0]?.slice(0, 200) ?? '';
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

  // The session surface is stdio-only; skip a present napi addon. Must be
  // set before the adapter module initializes the engine.
  process.env['KIMI_AGENT_FORCE_STDIO'] = '1';
  const rustLoop = await import('@moonshot-ai/kimi-agent/rust-loop');

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
  const controller = new SessionEngineController({
    // Wrap the real engine client factory. The captured native-LLM config is
    // typed, so it rides here rather than through the controller's opaque
    // `nativeLlm` option.
    createClient: (clientOptions) =>
      rustLoop.createSessionClient({
        sessionId: clientOptions.sessionId,
        systemPrompt: clientOptions.systemPrompt,
        model: clientOptions.model,
        goalEnabled: clientOptions.goalEnabled,
        homedir: clientOptions.homedir,
        nativeLlm,
        mcpServers,
        hooks,
        permissionMode: clientOptions.permissionMode,
        onEvent: clientOptions.onEvent,
        lifecycle: clientOptions.lifecycle,
      }),
    emitEvent: (event) => {
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
    },
    onRawEvent: (raw) => {
      const e = raw as { type?: string; status?: string };
      if (e.type === 'session.goal.updated' && e.status !== undefined && e.status !== 'none') {
        args.stderr.write(`[goal] ${e.status}\n`);
      }
    },
    // Print mode is permission `auto`: no approver is supplied, so the
    // engine's tool gate auto-allows (see SessionEngineController.authorize).
  });

  const started = await controller.start({
    sessionId: `print-${String(Date.now())}`,
    systemPrompt,
    model: nativeLlm.model,
    goalEnabled: true,
    homedir: args.workDir,
    nativeLlm,
    // Print mode is permission `auto`: configure the native gate so gated
    // tools (write/bash) are approved locally, with no host authorize
    // round-trip — the headless run needs no interactive approver.
    permissionMode: 'auto',
  });
  if (!started) {
    args.stderr.write(
      'session engine: stdio engine unavailable (no kimi-agent binary); falling back to the normal engine.\n',
    );
    return false;
  }

  const outcome = await controller.prompt(args.prompt);
  if (outcome === null) {
    args.stderr.write('session engine: prompt failed\n');
    return true; // handled (as a failure) — do not double-run on the fallback
  }
  if (sawText) args.stdout.write('\n');
  args.stderr.write(
    `[session-engine] stop=${outcome.stopReason} steps=${String(outcome.steps)} tokens=${String(outcome.totalTokens)}\n`,
  );
  await controller.save();
  return true;
}
