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

import { createUserMessage } from '@moonshot-ai/agent-core';
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, test } from 'vitest';

import { getVersion } from '#/cli/version';

const DEFAULT_PROMPT = 'Reply with a single word: hi';
const DEFAULT_WORKDIR = '/tmp/kimi-e2e';
const TURN_TIMEOUT_MS = 60_000;

const ENABLED = process.env['KIMI_E2E_REAL'] === '1';

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

      const harness = await createKimiHarness({
        identity: 'kimi-code-cli',
        uiMode: 'print',
        workDir,
        version,
      });

      try {
        const session = await harness.createSession();
        process.stderr.write(`[smoke] session created: ${session.id}\n`);
        if (modelAlias !== undefined) {
          const { AgentModelRef } = await import('@moonshot-ai/agent-core');
          const agentModel = session.main.resolve(AgentModelRef);
          if (agentModel === undefined) throw new Error('provider-catalog agent model is not available');
          await agentModel.setModel(modelAlias);
        }

        const result = await session.main.run(createUserMessage(prompt), {
          timeoutMs: TURN_TIMEOUT_MS,
        });
        process.stderr.write(`[smoke] turn done outcome=${result.outcome.type}\n`);
        expect(result.outcome.type).toBe('done');
      } finally {
        await harness.close().catch(() => {});
      }
    },
    TURN_TIMEOUT_MS + 10_000,
  );
});
