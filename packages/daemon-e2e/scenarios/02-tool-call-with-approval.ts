#!/usr/bin/env node
/**
 * Scenario 02 — tool call with approval.
 *
 * Asks the agent to run Bash and echo a canary token. The Bash tool triggers
 * an approval prompt; the framework's built-in `onApprovalRequested` handler
 * auto-approves it. We wait for `prompt.completed`, then assert:
 *
 *   - The tool emitted a `tool_result` whose output contains the canary.
 *   - The assistant message also surfaced the canary.
 *
 * Usage:
 *   DAEMON_URL=http://127.0.0.1:7878 npx tsx scenarios/02-tool-call-with-approval.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure, timeout, or daemon error
 */
import assert from 'node:assert/strict';

import { DaemonClient } from '../src/index';

const DAEMON_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';
const CANARY = `HELLO_FROM_AUDIT_${process.pid}`;

async function main() {
  const client = new DaemonClient({ baseUrl: DAEMON_URL });

  let sid: string | undefined;
  let approvalCount = 0;
  try {
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    sid = session.id;
    console.log(`▶ session ${sid} created`);

    await client.connect();
    await client.subscribe(sid);

    client.onApprovalRequested((req) => {
      approvalCount++;
      console.log(`▶ approval ${req.approval_id} requested for tool=${req.tool_name}`);
      return { decision: 'approved' };
    });

    const { prompt_id } = await client.submitAndWait(
      sid,
      {
        content: [
          {
            type: 'text',
            text: `Use the Bash tool to run \`echo ${CANARY}\` and then tell me the exact output you observed.`,
          },
        ],
      },
      { waitFor: 'prompt.completed', timeoutMs: 120_000 },
    );
    console.log(`▶ prompt ${prompt_id} completed; approvals=${approvalCount}`);

    assert.ok(approvalCount >= 1, 'expected at least one approval request');

    const { items } = await client.listMessages(sid, { page_size: 100 });
    // `prompt_id` on Message is optional (see scenario 01) — match by role
    // and accept any tool / assistant messages emitted in this session.
    const toolMessages = items.filter(
      (m) => m.role === 'tool' && (m.prompt_id === prompt_id || m.prompt_id === undefined),
    );
    const sawCanaryInTool = toolMessages.some((m) =>
      m.content.some(
        (part) =>
          part.type === 'tool_result' &&
          typeof part.output === 'string' &&
          part.output.includes(CANARY),
      ),
    );
    assert.ok(sawCanaryInTool, `expected canary "${CANARY}" in a tool_result`);

    const assistantText = items
      .filter(
        (m) => m.role === 'assistant' && (m.prompt_id === prompt_id || m.prompt_id === undefined),
      )
      .flatMap((m) => m.content)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    assert.ok(
      assistantText.includes(CANARY),
      `expected canary "${CANARY}" in assistant text, got: ${JSON.stringify(assistantText.slice(0, 300))}`,
    );

    // Session should be quiescent after prompt.completed.
    const final = await client.waitForSessionStatus(sid, 'idle', { timeoutMs: 10_000 });
    assert.equal(final.status, 'idle');

    console.log(`✓ 02-tool-call-with-approval: canary round-tripped end-to-end`);
  } finally {
    try {
      if (sid) await client.deleteSession(sid);
    } catch {
      // ignore
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error('✗ 02-tool-call-with-approval failed:', err);
  process.exit(1);
});
