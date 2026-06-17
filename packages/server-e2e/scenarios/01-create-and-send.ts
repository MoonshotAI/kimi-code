#!/usr/bin/env node
/**
 * Scenario 01 — create a session, submit a prompt asking for a 1-word reply,
 * poll messages, assert the assistant text contains the expected token.
 *
 * Usage:
 *   KIMI_SERVER_URL=http://127.0.0.1:58627 npx tsx scenarios/01-create-and-send.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure or server error
 */
import assert from 'node:assert/strict';

import { DaemonClient } from '../src/index';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const EXPECTED_TOKEN = 'OK';

async function main() {
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });

  let sid: string | undefined;
  try {
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    sid = session.id;
    console.log(`▶ session ${sid} created`);

    await client.connect();
    await client.subscribe(sid);

    const { prompt_id, finalFrame } = await client.submitAndWait(
      sid,
      {
        content: [
          {
            type: 'text',
            text: `Reply with the single word "${EXPECTED_TOKEN}" and nothing else.`,
          },
        ],
      },
      { waitFor: 'prompt.completed', timeoutMs: 60_000 },
    );
    console.log(`▶ prompt ${prompt_id} → finalFrame=${finalFrame.type}`);

    const { items } = await client.listMessages(sid, { page_size: 100 });
    // `prompt_id` on Message is optional (the adapter from agent-core doesn't
    // always populate it). Fall back to the latest assistant message, which
    // is unambiguous in a single-prompt scenario.
    const assistant =
      items.find((m) => m.role === 'assistant' && m.prompt_id === prompt_id) ??
      [...items].reverse().find((m) => m.role === 'assistant');
    assert.ok(assistant, 'expected at least one assistant message');

    const text = assistant.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    assert.ok(
      text.toUpperCase().includes(EXPECTED_TOKEN),
      `expected assistant text to contain "${EXPECTED_TOKEN}", got: ${JSON.stringify(text)}`,
    );

    console.log(`✓ 01-create-and-send: assistant replied "${text.trim()}"`);
  } finally {
    try {
      if (sid) await client.archiveSession(sid);
    } catch {
      // ignore
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error('✗ 01-create-and-send failed:', err);
  process.exit(1);
});
