/**
 * session-engine.ts — the phase-D thin-client pilot for print mode.
 *
 * `KIMI_SESSION_ENGINE=1 kimi -p "..."` routes the prompt through the
 * engine's session-owned surface instead of the agent-core harness: the
 * Rust engine owns the loop, context, goal driving, and persistence, talks
 * to the provider directly (native-LLM transport), and runs its own native
 * toolset — this side only parses arguments and renders streamed events.
 *
 * Pilot boundaries (deliberate):
 * - Requires a native-LLM-capable provider in the config; otherwise the
 *   caller falls back to the normal harness path with a notice.
 * - Print mode is permission `auto`, so the tool approval gate auto-allows;
 *   interactive approval UI arrives with the TUI integration.
 */
import { loadNativeLlmDef } from './rust-engine';
import { SessionEngineController } from './session-engine-controller';

interface SessionEngineIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface SessionEnginePromptArgs extends SessionEngineIo {
  prompt: string;
  workDir: string;
  homeDir?: string;
  configPath?: string;
}

/** Whether the session-engine pilot is switched on. */
export function isSessionEngineEnabled(): boolean {
  return process.env['KIMI_SESSION_ENGINE'] === '1';
}

/**
 * Try to run the prompt on the session-owned engine. Returns true when the
 * prompt was handled (successfully or not); false means "not applicable —
 * use the normal path" (pilot off, no native LLM, or engine unavailable).
 */
export async function tryRunSessionEnginePrompt(
  args: SessionEnginePromptArgs,
): Promise<boolean> {
  if (!isSessionEngineEnabled()) return false;

  const nativeLlm = loadNativeLlmDef(args.homeDir, args.configPath);
  if (nativeLlm === undefined) {
    args.stderr.write(
      'KIMI_SESSION_ENGINE=1 needs a native-LLM-capable provider (static-key openai/kimi/anthropic); falling back to the normal engine.\n',
    );
    return false;
  }

  // The session surface is stdio-only; skip a present napi addon. Must be
  // set before the adapter module initializes the engine.
  process.env['KIMI_AGENT_FORCE_STDIO'] = '1';
  const rustLoop = await import('@moonshot-ai/kimi-agent/rust-loop');

  let sawText = false;
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
        onEvent: clientOptions.onEvent,
        lifecycle: clientOptions.lifecycle,
      }),
    emitEvent: (event) => {
      // Native-LLM mode streams provider deltas as assistant text; render it
      // directly. (Thinking deltas stay off stdout in print mode.)
      if (event.type === 'assistant.delta') {
        sawText = true;
        args.stdout.write(event.delta);
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
    systemPrompt:
      'You are Kimi Code, an agentic coding assistant running in headless print mode. Answer directly and use tools when needed.',
    model: nativeLlm.model,
    goalEnabled: true,
    homedir: args.workDir,
    nativeLlm,
  });
  if (!started) {
    args.stderr.write(
      'KIMI_SESSION_ENGINE=1: stdio engine unavailable (no kimi-agent binary); falling back to the normal engine.\n',
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
