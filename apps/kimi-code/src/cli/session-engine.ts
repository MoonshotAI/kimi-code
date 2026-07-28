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
  const client = await rustLoop.createSessionClient({
    sessionId: `print-${String(Date.now())}`,
    systemPrompt:
      'You are Kimi Code, an agentic coding assistant running in headless print mode. Answer directly and use tools when needed.',
    model: nativeLlm.model,
    goalEnabled: true,
    homedir: args.workDir,
    nativeLlm,
    onEvent: (event) => {
      const e = event as {
        type?: string;
        part?: { type?: string; text?: string };
        status?: string;
      };
      // Native-LLM mode: the engine streams provider deltas; render text
      // parts directly. (Think parts stay off stdout in print mode.)
      if (e.type === 'llm.delta' && e.part?.type === 'text' && e.part.text !== undefined) {
        sawText = true;
        args.stdout.write(e.part.text);
      }
      if (e.type === 'session.goal.updated' && e.status !== undefined && e.status !== 'none') {
        args.stderr.write(`[goal] ${e.status}\n`);
      }
    },
    // Print mode runs with permission `auto`: the engine-native write gate
    // auto-allows (resolved: the decision is final, no further host UI),
    // mirroring the JS tools' behavior on this path.
    lifecycle: {
      authorizeTool: () => Promise.resolve({ block: false, resolved: true }),
    },
  });
  if (client === null) {
    args.stderr.write(
      'KIMI_SESSION_ENGINE=1: stdio engine unavailable (no kimi-agent binary); falling back to the normal engine.\n',
    );
    return false;
  }

  const result = await client.prompt(args.prompt);
  if (result === null) {
    args.stderr.write('session engine: prompt failed\n');
    return true; // handled (as a failure) — do not double-run on the fallback
  }
  if (sawText) args.stdout.write('\n');
  args.stderr.write(
    `[session-engine] stop=${result.stop_reason} steps=${String(result.steps)} tokens=${String(result.usage.total_tokens)}\n`,
  );
  await client.save();
  return true;
}
