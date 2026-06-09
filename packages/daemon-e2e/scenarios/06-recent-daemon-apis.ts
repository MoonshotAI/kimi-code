#!/usr/bin/env node
/**
 * Scenario 06 — recent daemon API coverage.
 *
 * Exercises the daemon surfaces added in the recent branch history:
 *
 *   - model/provider catalog reads, plus a no-op `:set_default` when the
 *     current default is present in `/models`;
 *   - direct child-session creation and direct-child listing;
 *   - pending approval recovery via `GET /approvals?status=pending`;
 *   - pending question recovery via `GET /questions?status=pending`;
 *   - uploaded-file prompt references, including pre-submit error mapping for
 *     missing/non-image file ids and successful PNG file prompt submission.
 *
 * Usage:
 *   DAEMON_URL=http://127.0.0.1:7878 npx tsx scenarios/06-recent-daemon-apis.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure, timeout, or daemon error
 */
import assert from 'node:assert/strict';

import { ErrorCode, type QuestionAnswer } from '@moonshot-ai/protocol';

import { DaemonClient, EnvelopeError, type AnyFrame } from '../src/index';

const DAEMON_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';
const PROMPT_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 15_000;
const CANARY = `DAEMON_E2E_RECENT_${process.pid}`;

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

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
  console.log(`▶ daemon at ${DAEMON_URL}`);
  const client = new DaemonClient({ baseUrl: DAEMON_URL });
  const sessions: string[] = [];
  const files: string[] = [];

  try {
    await exerciseCatalog(client);

    const parent = await client.createSession({
      title: 'daemon-e2e recent APIs',
      metadata: { cwd: process.cwd(), scenario: '06-recent-daemon-apis' },
    });
    sessions.push(parent.id);
    console.log(`▶ parent session ${parent.id} created`);

    await exerciseChildren(client, parent.id, sessions);

    await client.connect();
    await client.subscribe(parent.id);

    await exerciseApprovalRecovery(client, parent.id);
    await exerciseQuestionRecovery(client, parent.id);
    await exerciseImageFilePrompts(client, parent.id, files);

    console.log('✓ 06-recent-daemon-apis: recent daemon surfaces round-tripped');
  } finally {
    for (const fileId of files.toReversed()) {
      try {
        await client.deleteFile(fileId);
      } catch {
        // ignore
      }
    }
    for (const sid of sessions.toReversed()) {
      try {
        await client.deleteSession(sid);
      } catch {
        // ignore
      }
    }
    await client.close();
  }
}

async function exerciseCatalog(client: DaemonClient): Promise<void> {
  const auth = await client.getAuth();
  const models = await client.listModels();
  const providers = await client.listProviders();
  assert.ok(Array.isArray(models.items), 'GET /models returns items[]');
  assert.ok(Array.isArray(providers.items), 'GET /providers returns items[]');
  console.log(
    `▶ catalog: models=${models.items.length} providers=${providers.items.length} default=${auth.default_model ?? '<none>'}`,
  );

  const firstProvider = providers.items[0];
  if (firstProvider !== undefined) {
    const provider = await client.getProvider(firstProvider.id);
    assert.equal(provider.id, firstProvider.id, 'GET /providers/{id} returns the requested provider');
    console.log(`▶ catalog: provider ${provider.id} status=${provider.status}`);
  }

  const defaultModel = auth.default_model;
  if (defaultModel === null || !models.items.some((item) => item.model === defaultModel)) {
    console.log('▶ catalog: set_default skipped because current default is not in /models');
    return;
  }
  const setDefault = await client.setDefaultModel(defaultModel);
  assert.equal(setDefault.default_model, defaultModel);
  assert.equal(setDefault.model.model, defaultModel);
  console.log(`▶ catalog: POST /models/${defaultModel}:set_default returned current default`);
}

async function exerciseChildren(
  client: DaemonClient,
  parentId: string,
  sessions: string[],
): Promise<void> {
  const child = await client.createChild(parentId, {
    title: 'daemon-e2e child',
    metadata: { branch: 'direct-child' },
  });
  sessions.push(child.id);
  assert.equal(child.metadata['parent_session_id'], parentId);
  assert.equal(child.metadata['child_session_kind'], 'child');

  const grandchild = await client.createChild(child.id, {
    title: 'daemon-e2e grandchild',
    metadata: { branch: 'grandchild' },
  });
  sessions.push(grandchild.id);

  const parentChildren = await client.listChildren(parentId, { page_size: 10 });
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
  console.log(
    `▶ children: parent=${parentId} child=${child.id} grandchild=${grandchild.id}`,
  );
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
  console.log(
    `▶ approval: pending approval ${approval.approval_id} tool=${approval.tool_name}`,
  );

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
          'Ask exactly one question: "Which daemon e2e recovery option should continue?"',
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
  console.log(
    `▶ question: pending question ${question.question_id} items=${listed.questions.length}`,
  );

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

async function exerciseImageFilePrompts(
  client: DaemonClient,
  sid: string,
  files: string[],
): Promise<void> {
  await expectEnvelopeCode(
    () =>
      client.submitPrompt(sid, {
        content: [
          {
            type: 'image',
            source: { kind: 'file', file_id: 'file_missing_daemon_e2e' },
          },
        ],
      }),
    ErrorCode.FILE_NOT_FOUND,
    'missing prompt image file_id',
  );

  const textFile = await client.uploadFile({
    name: 'not-an-image.txt',
    data: 'not an image',
    mediaType: 'text/plain',
  });
  files.push(textFile.id);
  await expectEnvelopeCode(
    () =>
      client.submitPrompt(sid, {
        content: [
          {
            type: 'image',
            source: { kind: 'file', file_id: textFile.id },
          },
        ],
      }),
    ErrorCode.VALIDATION_FAILED,
    'non-image prompt file_id',
  );

  const png = await client.uploadFile({
    name: 'tiny.png',
    data: ONE_BY_ONE_PNG,
    mediaType: 'image/png',
  });
  files.push(png.id);
  assert.equal(png.media_type, 'image/png');
  assert.equal(png.size, ONE_BY_ONE_PNG.length);

  const submit = await client.submitPrompt(sid, {
    content: [
      { type: 'text', text: 'Reply with the single word "OK" after reading this image.' },
      { type: 'image', source: { kind: 'file', file_id: png.id } },
    ],
  });
  assert.ok(submit.prompt_id.length > 0, 'image file prompt returns a prompt_id');
  console.log(`▶ image-file: uploaded ${png.id} and submitted prompt ${submit.prompt_id}`);

  try {
    await client.abortPrompt(sid, submit.prompt_id);
    console.log(`▶ image-file: prompt ${submit.prompt_id} aborted after submit`);
  } catch (error) {
    if (
      error instanceof EnvelopeError &&
      (error.code === ErrorCode.PROMPT_ALREADY_COMPLETED ||
        error.code === ErrorCode.PROMPT_NOT_FOUND)
    ) {
      console.log(`▶ image-file: prompt ${submit.prompt_id} was already terminal before abort`);
    } else {
      throw error;
    }
  }
  await client.waitForSessionStatus(sid, 'idle', { timeoutMs: SHORT_TIMEOUT_MS });
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
  console.log(`▶ image-file: ${label} returned code=${caught.code}`);
}

main().catch((err) => {
  console.error('✗ 06-recent-daemon-apis failed:', err);
  process.exit(1);
});
