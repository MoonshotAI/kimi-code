/**
 * Real-LLM smoke. Opt-in only — runs when `KIMI_E2E_REAL=1` is set, so
 * `make test` / CI never touches the network. Goes through the SDK's
 * `KimiHarness` entry and round-trips one real prompt. Requires provider
 * credentials on disk.
 *
 * Env knobs:
 *   KIMI_E2E_REAL     — set to "1" to enable this suite
 *   KIMI_E2E_MODEL    — model alias override (default: config's default)
 *   KIMI_E2E_PROMPT   — prompt text (default: "Reply with a single word: hi")
 *   KIMI_E2E_WORKDIR  — workspace directory (default: /tmp/kimi-e2e)
 */

import { mkdirSync } from 'node:fs';
import process from 'node:process';

import { createKimiHarness, type Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, test } from 'vitest';

import { createKimiCodeHostIdentity, getVersion } from '#/cli/version';

const DEFAULT_PROMPT = 'Reply with a single word: hi';
const DEFAULT_WORKDIR = '/tmp/kimi-e2e';
const TURN_TIMEOUT_MS = 60_000;

const ENABLED = process.env['KIMI_E2E_REAL'] === '1';
type TurnEndedEvent = Extract<Event, { readonly type: 'turn.ended' }>;

describe.skipIf(!ENABLED)('SDK e2e — real LLM smoke', () => {
  test(
    'round-trips a single prompt through KimiHarness',
    async () => {
      const workDir = process.env['KIMI_E2E_WORKDIR'] ?? DEFAULT_WORKDIR;
      const prompt = process.env['KIMI_E2E_PROMPT'] ?? DEFAULT_PROMPT;
      const modelAlias = process.env['KIMI_E2E_MODEL'];
      mkdirSync(workDir, { recursive: true });

      const version = getVersion();
      process.stderr.write(
        `[smoke] workDir=${workDir}${modelAlias !== undefined ? ` model=${modelAlias}` : ''}\n` +
          `[smoke] prompt=${JSON.stringify(prompt)}\n`,
      );

      const harness = createKimiHarness({
        identity: createKimiCodeHostIdentity(version),
      });

      try {
        const session = await harness.createSession({
          workDir,
          model: modelAlias,
        });
        process.stderr.write(`[smoke] session created: ${session.id}\n`);

        const turnEnded = new Promise<TurnEndedEvent>((resolve) => {
          const off = session.onEvent((event) => {
            const payload = JSON.stringify(event).slice(0, 500);
            process.stdout.write(`[smoke][event:${event.type}] ${payload}\n`);
            if (event.type === 'turn.ended') {
              off();
              resolve(event);
            }
          });
        });

        await session.prompt(prompt);
        process.stderr.write('[smoke] prompt dispatched\n');

        const event = await turnEnded;
        process.stderr.write(`[smoke] turn.ended reason=${event.reason}\n`);
        if (event.error !== undefined) {
          process.stderr.write(`[smoke] error=${event.error.message}\n`);
        }
        expect(event.reason).toBe('completed');
      } finally {
        await harness.close().catch(() => {});
      }
    },
    TURN_TIMEOUT_MS + 10_000,
  );
});
