#!/usr/bin/env node
/**
 * Scenario 08 — pending reverse-RPC recovery APIs.
 *
 * Exercises:
 *   - GET /sessions/{id}/approvals?status=pending
 *   - POST /sessions/{id}/approvals/{approval_id}
 *   - GET /sessions/{id}/questions?status=pending
 *   - POST /sessions/{id}/questions/{question_id}
 */
import assert from 'node:assert/strict';

import type { QuestionAnswer } from '@moonshot-ai/protocol';

import { DaemonClient, type AnyFrame } from '../src/index';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const PROMPT_TIMEOUT_MS = 120_000;
const CANARY = `KIMI_SERVER_E2E_PENDING_${process.pid}`;

interface ApprovalRequestedPayload {
  approval_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  action: string;
  created_at: string;
  expires_at: string;
}

interface QuestionRequestedPayload {
  question_id: string;
  session_id: string;
  questions: Array<{
    id: string;
    question: string;
    options: Array<{ id: string; label: string }>;
  }>;
  created_at: string;
  expires_at: string;
}

async function main() {
  console.log(`▶ server at ${KIMI_SERVER_URL}`);
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });
  let sid: string | undefined;

  try {
    const session = await client.createSession({
      title: 'server-e2e pending recovery',
      metadata: { cwd: process.cwd(), scenario: '08-pending-recovery' },
    });
    sid = session.id;
    console.log(`▶ pending: session ${sid} created`);

    await client.connect();
    await client.subscribe(sid);

    await exerciseApprovalRecovery(client, sid);
    await exerciseQuestionRecovery(client, sid);

    console.log('✓ 08-pending-recovery: pending approvals and questions round-tripped');
  } finally {
    try {
      if (sid) await client.archiveSession(sid);
    } catch {
      // ignore
    }
    await client.close();
  }
}

async function exerciseApprovalRecovery(client: DaemonClient, sid: string): Promise<void> {
  const approvalFramePromise = client.waitForFrame(isApprovalRequestedFor(sid), {
    timeoutMs: PROMPT_TIMEOUT_MS,
  });
  const submit = await client.submitPrompt(sid, {
    content: [
      {
        type: 'text',
        text: `Use the Bash tool to run \`echo ${CANARY}\`, then tell me the exact output you observed.`,
      },
    ],
  });
  console.log(`▶ approval: prompt ${submit.prompt_id} submitted`);

  const frame = await approvalFramePromise;
  const approval = payloadOf<ApprovalRequestedPayload>(frame);
  assert.equal(approval.session_id, sid);

  const pending = await client.listPendingApprovals(sid);
  const listed = pending.items.find((item) => item.approval_id === approval.approval_id);
  assert.ok(listed, 'pending approvals list includes the requested approval');
  assert.equal(listed.tool_call_id, approval.tool_call_id);
  assert.equal(listed.tool_name, approval.tool_name);
  console.log(`▶ approval: pending approval ${approval.approval_id} tool=${approval.tool_name}`);

  const resolved = await client.resolveApproval(sid, approval.approval_id, {
    decision: 'approved',
  });
  assert.equal(resolved.resolved, true);

  const after = await client.listPendingApprovals(sid);
  assert.equal(
    after.items.some((item) => item.approval_id === approval.approval_id),
    false,
    'resolved approval is removed from pending list',
  );

  const finalFrame = await client.waitForFrame(isPromptCompleted(submit.prompt_id), {
    timeoutMs: PROMPT_TIMEOUT_MS,
  });
  console.log(`▶ approval: prompt completed via ${finalFrame.type}`);
}

async function exerciseQuestionRecovery(client: DaemonClient, sid: string): Promise<void> {
  const questionFramePromise = client.waitForFrame(isQuestionRequestedFor(sid), {
    timeoutMs: PROMPT_TIMEOUT_MS,
  });
  const submit = await client.submitPrompt(sid, {
    content: [
      {
        type: 'text',
        text: [
          'Use the AskUserQuestion tool now.',
          'Ask exactly one question: "Which server e2e recovery option should continue?"',
          'Use header "E2E".',
          'Use two options: "Continue (Recommended)" and "Stop".',
          'After I answer, reply with the selected option label.',
        ].join(' '),
      },
    ],
  });
  console.log(`▶ question: prompt ${submit.prompt_id} submitted`);

  const frame = await questionFramePromise;
  const question = payloadOf<QuestionRequestedPayload>(frame);
  assert.equal(question.session_id, sid);

  const pending = await client.listPendingQuestions(sid);
  const listed = pending.items.find((item) => item.question_id === question.question_id);
  assert.ok(listed, 'pending questions list includes the requested question');
  assert.ok(listed.questions.length > 0, 'pending question carries questions[]');
  console.log(`▶ question: pending question ${question.question_id} items=${listed.questions.length}`);

  const answers: Record<string, QuestionAnswer> = {};
  for (const item of listed.questions) {
    const firstOption = item.options[0];
    assert.ok(firstOption, `question ${item.id} should have at least one option`);
    answers[item.id] = { kind: 'single', option_id: firstOption.id };
  }

  const resolved = await client.resolveQuestion(sid, question.question_id, {
    answers,
    method: 'click',
  });
  assert.equal(resolved.resolved, true);

  const after = await client.listPendingQuestions(sid);
  assert.equal(
    after.items.some((item) => item.question_id === question.question_id),
    false,
    'resolved question is removed from pending list',
  );

  const finalFrame = await client.waitForFrame(isPromptCompleted(submit.prompt_id), {
    timeoutMs: PROMPT_TIMEOUT_MS,
  });
  console.log(`▶ question: prompt completed via ${finalFrame.type}`);
}

function isApprovalRequestedFor(sid: string): (frame: AnyFrame) => boolean {
  return (frame) =>
    frame.type === 'event.approval.requested' &&
    payloadSessionId(frame) === sid;
}

function isQuestionRequestedFor(sid: string): (frame: AnyFrame) => boolean {
  return (frame) =>
    frame.type === 'event.question.requested' &&
    payloadSessionId(frame) === sid;
}

function isPromptCompleted(promptId: string): (frame: AnyFrame) => boolean {
  return (frame) => {
    if (frame.type !== 'prompt.completed') return false;
    const payload = (frame.payload ?? {}) as { prompt_id?: string; promptId?: string };
    return (payload.prompt_id ?? payload.promptId) === promptId;
  };
}

function payloadSessionId(frame: AnyFrame): string | undefined {
  const payload = frame.payload as { session_id?: string } | undefined;
  return payload?.session_id;
}

function payloadOf<T>(frame: AnyFrame): T {
  assert.ok(frame.payload !== undefined, `${frame.type} frame should carry payload`);
  return frame.payload as T;
}

main().catch((err) => {
  console.error('✗ 08-pending-recovery failed:', err);
  process.exit(1);
});
