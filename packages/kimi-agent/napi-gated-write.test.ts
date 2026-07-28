// E2E: write-class tools on the napi transport run behind the host approval
// gate (prepare → authorize → native execute → finalize). Requires the addon
// (`cargo build -p kimi-agent --features napi`), same as napi-integration.
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

const nativeRequire = createRequire(import.meta.url);

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'kimi-gated-write-'));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Drive one turn whose first step calls Write, with lifecycle channels. */
async function runWriteTurn(options: {
  authorizeBlock: boolean;
  calls: { prepare: number; authorize: number; finalize: number; hostExecute: number };
}) {
  const native = nativeRequire('./kimi_agent.node');
  let llmCalls = 0;

  const handler =
    (fn: (payload: string) => string | Promise<string>) => (callbackId: number) => {
      const payload = native.getCallbackPayload(callbackId);
      if (!payload) return;
      void Promise.resolve(fn(payload)).then(
        (result) => native.resolveCallback(callbackId, null, result),
        (error: unknown) => native.resolveCallback(callbackId, String(error), null),
      );
    };

  const result = await native.runTurnRust(
    {
      turnId: 'gated-w1',
      systemPrompt: 'smoke',
      modelName: 'mock',
      messages: [],
      tools: [{ name: 'Write', description: 'write', inputSchema: '{"type":"object"}' }],
      maxSteps: 3,
      workspaceRoot: workspace,
      nativeTools: true,
    },
    handler(() => {
      llmCalls++;
      if (llmCalls === 1) {
        return JSON.stringify({
          tool_calls: [
            {
              id: 'w1',
              name: 'Write',
              arguments: { path: 'out.txt', content: 'gated' },
            },
          ],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      return JSON.stringify({
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }),
    handler(() => {
      options.calls.hostExecute++;
      return JSON.stringify({ content: 'host executed', is_error: false });
    }),
    undefined,
    handler(() => {
      options.calls.prepare++;
      return JSON.stringify(null);
    }),
    handler(() => {
      options.calls.authorize++;
      return JSON.stringify(
        options.authorizeBlock
          ? { block: true, reason: 'denied by e2e gate', resolved: true }
          : null,
      );
    }),
    handler(() => {
      options.calls.finalize++;
      return JSON.stringify(null);
    }),
  );
  return result;
}

test('an approved napi Write runs natively behind the full lifecycle', async () => {
  const calls = { prepare: 0, authorize: 0, finalize: 0, hostExecute: 0 };
  const result = await runWriteTurn({ authorizeBlock: false, calls });
  expect(result.stopReason).toBe('EndTurn');
  expect(calls.prepare).toBe(1);
  expect(calls.authorize).toBe(1);
  expect(calls.finalize).toBe(1);
  expect(calls.hostExecute).toBe(0);
  expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('gated');
}, 15000);

test('a blocked napi Write never touches the filesystem', async () => {
  const calls = { prepare: 0, authorize: 0, finalize: 0, hostExecute: 0 };
  const result = await runWriteTurn({ authorizeBlock: true, calls });
  expect(result.stopReason).toBe('EndTurn');
  expect(calls.authorize).toBe(1);
  expect(calls.finalize).toBe(0);
  expect(calls.hostExecute).toBe(0);
  expect(existsSync(join(workspace, 'out.txt'))).toBe(false);
}, 15000);
