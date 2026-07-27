/**
 * Trace how the reported "Context size" evolves on a brand-new session after
 * a single "hi" prompt, against an in-process engine over the memory
 * transport.
 *
 * What gets sampled, all through the klient facade:
 *   - `agent.getContext()` → `{ history, tokenCount }` — `tokenCount` is the
 *     last MEASURED exchange total (`contextSize.get().measured` engine-side);
 *     it is 0 until the first LLM response lands and stays flat between turns.
 *   - `agent.getUsage()` → accumulated token usage (`byModel` / `currentTurn`
 *     / `total`), recorded per request.
 *   - `agent.status.updated` events — the live `contextTokens` / `usage`
 *     slices that feed the TUI footer.
 *
 * A 250 ms poll diffs (history length, tokenCount, usage.total) and prints a
 * line only when something changed, so the output is a timeline of exactly
 * when the Context size reading moves — and when it does NOT.
 *
 * A throwaway model is seeded into the engine's temp home (an in-process
 * engine has no default model), so both env vars are required. Run it (the
 * engine sources need the decorators tsconfig + raw-text loader):
 *   KIMI_EXAMPLE_MODEL=... KIMI_EXAMPLE_API_KEY=... \
 *   pnpm -C packages/klient exec tsx --tsconfig ./tsconfig.examples.json \
 *     --import ../../build/register-raw-text-loader.mjs examples/context-usage.ts
 *
 * Env:
 *   KIMI_EXAMPLE_MODEL      — gateway model id to seed (required)
 *   KIMI_EXAMPLE_API_KEY    — API key for the seeded model (required)
 *   KIMI_EXAMPLE_BASE_URL   — optional gateway base URL for the seeded model
 *   KIMI_EXAMPLE_PROTOCOL   — optional wire protocol for the seeded model (default `openai`)
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { createKlient } from '@moonshot-ai/klient/memory';

const SEEDED_MODEL_ID = 'klient-example-model';

interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

function usageTotal(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  const seedModel = process.env['KIMI_EXAMPLE_MODEL'];
  const seedKey = process.env['KIMI_EXAMPLE_API_KEY'];
  if (seedModel === undefined || seedKey === undefined) {
    throw new Error('KIMI_EXAMPLE_MODEL and KIMI_EXAMPLE_API_KEY are required (see header)');
  }

  const homeDir = await mkdtemp(join(tmpdir(), 'klient-context-usage-'));
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  try {
    const klient = createKlient({ scope: app });

    const session = await klient.global.sessions.create({ workDir: process.cwd() });
    console.log('[session] created ->', session.id);
    const agent = klient.session(session.id).agent('main');

    await klient.global.kosong.addProvider({
      id: SEEDED_MODEL_ID,
      model: seedModel,
      protocol: (process.env['KIMI_EXAMPLE_PROTOCOL'] ?? 'openai'),
      baseUrl: process.env['KIMI_EXAMPLE_BASE_URL'] ?? 'http://127.0.0.1:1',
      auth: { method: 'api-key', apiKey: seedKey },
      maxContextSize: 262_144,
    });
    await agent.setModel(SEEDED_MODEL_ID);
    console.log('[model]   bound   ->', await agent.getModel());

    const startedAt = Date.now();
    const elapsed = (): string => `+${String(Date.now() - startedAt).padStart(6)}ms`;

    // Live status slices (what the TUI footer consumes), as they arrive.
    agent.events.on('agent.status.updated', (event) => {
      const slice: Record<string, unknown> = {};
      if ('contextTokens' in event) slice['contextTokens'] = event['contextTokens'];
      if ('maxContextTokens' in event) slice['maxContextTokens'] = event['maxContextTokens'];
      if ('contextUsage' in event) slice['contextUsage'] = event['contextUsage'];
      if ('phase' in event) slice['phase'] = event['phase'];
      const usage = event['usage'] as { total?: TokenUsage } | undefined;
      if (usage !== undefined) slice['usage.total'] = usageTotal(usage.total);
      console.log(`[event]   ${elapsed()} agent.status.updated ->`, JSON.stringify(slice));
    });
    agent.events.on('turn.started', (event) => {
      console.log(`[event]   ${elapsed()} turn.started         -> turnId=${String(event.turnId)}`);
    });
    agent.events.on('turn.ended', (event) => {
      console.log(`[event]   ${elapsed()} turn.ended           -> reason=${event.reason}`);
    });
    agent.events.on('error', (event) => {
      console.log(`[event]   ${elapsed()} error                ->`, JSON.stringify(event));
    });
    agent.events.onError((error) => {
      console.log(`[event-err] ${elapsed()} ${error.message.split('\n')[0] ?? error.message}`);
    });

    const completed = new Promise<'completed' | 'failed' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve('timeout');
      }, 120_000);
      const sub = agent.events.on('prompt.completed', (event) => {
        clearTimeout(timer);
        sub.dispose();
        console.log(
          `[event]   ${elapsed()} prompt.completed     -> reason=${event.reason ?? 'unknown'}`,
        );
        resolve(event.reason === 'failed' ? 'failed' : 'completed');
      });
    });

    // Diff-polled snapshot of the RPC-visible readings.
    let lastKey = '';
    const snapshot = async (tag: string): Promise<void> => {
      const [ctx, usage] = await Promise.all([agent.getContext(), agent.getUsage()]);
      const total = usageTotal(usage.total);
      const turn = usageTotal(usage.currentTurn);
      const key = `${String(ctx.history.length)}/${String(ctx.tokenCount)}/${String(total)}/${String(turn)}`;
      if (key === lastKey) return;
      lastKey = key;
      console.log(
        `[poll]    ${elapsed()} ${tag}`.padEnd(46),
        `history=${String(ctx.history.length)}  tokenCount(measured)=${String(ctx.tokenCount)}` +
          `  usage.total=${String(total)}  usage.currentTurn=${String(turn)}`,
      );
    };

    let polling = true;
    const pollLoop = (async (): Promise<void> => {
      while (polling) {
        try {
          await snapshot('');
        } catch {
          // transient RPC failure during the turn — keep polling
        }
        await tick(250);
      }
    })();

    await snapshot('created (pre-prompt)');
    console.log(`[prompt]  ${elapsed()} sending "hi"`);
    await agent.prompt({ input: [{ type: 'text', text: 'hi' }] });

    const outcome = await completed;
    polling = false;
    await pollLoop;
    lastKey = ''; // force the final line even if nothing moved since the last poll tick
    await snapshot('after prompt.completed');

    const ctx = await agent.getContext();
    const usage = await agent.getUsage();
    const total = usageTotal(usage.total);
    console.log('---');
    console.log('[result]  outcome              ->', outcome);
    console.log('[result]  history messages     ->', ctx.history.length);
    console.log('[result]  tokenCount (measured) ->', ctx.tokenCount);
    console.log('[result]  usage.total           ->', JSON.stringify(usage.total));
    console.log('[result]  usage.byModel         ->', JSON.stringify(usage.byModel));
    console.log(
      `[check]   tokenCount vs usage.total -> ${String(ctx.tokenCount)} vs ${String(total)}`,
    );
    console.log(
      '[note]    reading guide:\n' +
        '          - tokenCount is 0 until the first measured exchange lands, then it\n' +
        '            should equal THAT exchange\'s total (input + output); new messages\n' +
        '            appended between turns are the unmeasured tail.\n' +
        '          - after one covered exchange on a fresh session, cumulative\n' +
        '            usage.total and tokenCount should roughly agree; a large gap means\n' +
        '            the measured total never made it onto the wire model and the reading\n' +
        '            silently fell back to per-message estimates.\n' +
        '          - outcome "timeout" means the turn finished its work but the\n' +
        '            prompt.completed event never reached the client.',
    );
    console.log('[note]    session left in the (disposed) temp home ->', session.id);

    await klient.close();
    if (outcome === 'failed') process.exit(1);
  } finally {
    app.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
