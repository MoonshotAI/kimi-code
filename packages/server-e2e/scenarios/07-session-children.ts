#!/usr/bin/env node
/**
 * Scenario 07 — direct child sessions.
 *
 * Exercises:
 *   - POST /sessions/{id}/children
 *   - GET /sessions/{id}/children
 *   - parent sessions can run prompts before child creation
 *   - child sessions can run prompts
 *   - direct-child listing omits grandchildren
 *   - missing parent returns 40401
 */
import assert from 'node:assert/strict';

import { ErrorCode } from '@moonshot-ai/protocol';

import { DaemonClient, EnvelopeError } from '../src/index';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const PROMPT_TIMEOUT_MS = 120_000;
const PARENT_PROMPT_TOKEN = 'PARENT_SESSION_OK';
const CHILD_PROMPT_TOKEN = 'CHILD_SESSION_OK';

async function main() {
  console.log(`▶ server at ${KIMI_SERVER_URL}`);
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });
  const sessions: string[] = [];

  try {
    const parent = await client.createSession({
      title: 'server-e2e session children',
      metadata: { cwd: process.cwd(), scenario: '07-session-children' },
    });
    sessions.push(parent.id);
    console.log(`▶ children: parent session ${parent.id} created`);

    await client.connect();
    await client.subscribe(parent.id);
    await submitPromptAndAssertToken(client, parent.id, PARENT_PROMPT_TOKEN, 'parent');

    const child = await client.createChild(parent.id, {
      title: 'server-e2e child',
      metadata: { branch: 'direct-child' },
    });
    sessions.push(child.id);
    assert.equal(child.metadata['parent_session_id'], parent.id);
    assert.equal(child.metadata['child_session_kind'], 'child');
    console.log(`▶ children: child session ${child.id} created`);

    await client.subscribe(child.id);
    await submitPromptAndAssertToken(client, child.id, CHILD_PROMPT_TOKEN, 'child');

    const grandchild = await client.createChild(child.id, {
      title: 'server-e2e grandchild',
      metadata: { branch: 'grandchild' },
    });
    sessions.push(grandchild.id);
    console.log(`▶ children: grandchild session ${grandchild.id} created`);

    const parentChildren = await client.listChildren(parent.id, { page_size: 10 });
    assert.ok(
      parentChildren.items.some((item) => item.id === child.id),
      'parent children list includes the direct child',
    );
    assert.equal(
      parentChildren.items.some((item) => item.id === grandchild.id),
      false,
      'parent children list omits grandchildren',
    );

    const childChildren = await client.listChildren(child.id, { page_size: 10 });
    assert.ok(
      childChildren.items.some((item) => item.id === grandchild.id),
      'child children list includes the grandchild',
    );

    await expectEnvelopeCode(
      () => client.listChildren(`sess_missing_children_${process.pid}`, { page_size: 10 }),
      ErrorCode.SESSION_NOT_FOUND,
      'GET /sessions/{id}/children missing parent',
    );

    console.log('✓ 07-session-children: child session creation, execution, and listing round-tripped');
  } finally {
    for (const sid of sessions.toReversed()) {
      try {
        await client.archiveSession(sid);
      } catch {
        // ignore
      }
    }
    await client.close();
  }
}

async function submitPromptAndAssertToken(
  client: DaemonClient,
  sid: string,
  token: string,
  label: 'parent' | 'child',
): Promise<void> {
  const prompt = await client.submitAndWait(
    sid,
    {
      content: [
        {
          type: 'text',
          text: `Reply with the exact token ${token} and nothing else.`,
        },
      ],
    },
    { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
  );

  const messages = await client.listMessages(sid, { page_size: 100 });
  const assistant =
    messages.items.find(
      (message) => message.role === 'assistant' && message.prompt_id === prompt.prompt_id,
    ) ??
    messages.items.find((message) => message.role === 'assistant');
  assert.ok(assistant, `${label} prompt should produce an assistant message`);
  const assistantText = assistant.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  assert.ok(
    assistantText.includes(token),
    `${label} assistant text should contain ${token}, got ${JSON.stringify(assistantText)}`,
  );
  console.log(`▶ children: ${label} prompt ${prompt.prompt_id} completed via ${prompt.finalFrame.type}`);
}

async function expectEnvelopeCode(
  action: () => Promise<unknown>,
  code: ErrorCode,
  label: string,
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EnvelopeError, `${label}: expected EnvelopeError`);
  assert.equal(caught.code, code, `${label}: expected code ${code}, got ${caught.code}`);
  console.log(`▶ children: ${label} returned code=${caught.code}`);
}

main().catch((err) => {
  console.error('✗ 07-session-children failed:', err);
  process.exit(1);
});
