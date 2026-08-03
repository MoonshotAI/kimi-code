/**
 * Rust-transport interaction services round trip: sessionApprovalService
 * (engine approval store), sessionQuestionService (engine `question`
 * background tasks) and sessionInteractionService (the synthesized pending
 * interaction kernel). The channel is assembled directly (`RustChannel` +
 * `createKlientFromChannel`) and only the S1+S2 service module is imported —
 * the registry's sibling group modules land in parallel and may not exist
 * yet. Run with `KIMI_AGENT_FORCE_STDIO=1` so the engine reaches the stdio
 * binary (the session-owned surface is stdio-only).
 */
import { describe, expect, it } from 'vitest';
import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';

import { createKlientFromChannel, type Klient } from '#/core/klient';
import { RustChannel } from '#/transports/rust/channel';
// Side-effect import: self-registers the three interaction services.
import '#/transports/rust/services/interaction';

function createTestKlient(): Klient {
  const channel = new RustChannel({
    rust: rustLoop as unknown as typeof rustLoop,
    host: { homeDir: process.cwd(), configPath: 'config.toml' },
  });
  return createKlientFromChannel(channel);
}

describe('rust interaction services', () => {
  it('approval list/resolve round-trips on the engine approval store', async () => {
    const klient = createTestKlient();
    try {
      const session = klient.session('ses_approval_roundtrip');

      // Fresh session: no pending approvals, and the interaction kernel
      // mirrors the same (empty) pool.
      expect(await session.approvals.list()).toEqual([]);
      expect(await session.interactions.list('approval')).toEqual([]);

      // Unknown-id decide round-trips `session/approval_resolve` and no-ops
      // (v2 kernel parity) — the engine reports `{ resolved: false }`.
      await expect(
        session.approvals.decide('approval-missing-1', { decision: 'approved', scope: 'session' }),
      ).resolves.toBeUndefined();
      await expect(
        session.approvals.decide('approval-missing-2', { decision: 'rejected', feedback: 'nope' }),
      ).resolves.toBeUndefined();

      // Resolving an unknown id must not leave a phantom entry behind.
      expect(await session.approvals.list()).toEqual([]);

      // NOTE: a *real* pending approval requires a deferred tool call inside
      // a live turn (the engine's gate parks it), which needs a model step
      // this transport does not provide; the RPC pair itself is exercised
      // above against the live engine store.
    } finally {
      await klient.close();
    }
  });

  it('question list/answer round-trips on engine question background tasks', async () => {
    const klient = createTestKlient();
    try {
      const session = klient.session('ses_question_roundtrip');

      // Seed a `question`-kind background task through the engine's bg
      // surface (the only RPC-reachable way to create one).
      const registered = await rustLoop.bgRegister({
        prefix: 'question',
        kind: 'question',
        description: 'Which auth?',
      });
      expect(registered?.task_id).toBeTruthy();
      const taskId = registered!.task_id!;

      const pending = await session.questions.list();
      const match = pending.find((q) => q.id === taskId);
      expect(match).toBeDefined();
      expect(match!.questions[0]!.question).toBe('Which auth?');

      await expect(
        session.questions.answer(taskId, { answers: { q1: 'github' } }),
      ).resolves.toBeUndefined();

      // Answered → the task settles and leaves the pending roster.
      expect((await session.questions.list()).find((q) => q.id === taskId)).toBeUndefined();
      const settled = (await rustLoop.bgGet(taskId)) as {
        base?: { status?: string };
      };
      expect(settled.base?.status).toBe('completed');
    } finally {
      await klient.close();
    }
  });

  it('question dismiss settles the task as dismissed', async () => {
    const klient = createTestKlient();
    try {
      const session = klient.session('ses_question_dismiss');

      const registered = await rustLoop.bgRegister({
        prefix: 'question',
        kind: 'question',
        description: 'Proceed?',
      });
      expect(registered?.task_id).toBeTruthy();
      const taskId = registered!.task_id!;

      await expect(session.questions.dismiss(taskId)).resolves.toBeUndefined();
      expect((await session.questions.list()).find((q) => q.id === taskId)).toBeUndefined();
      const settled = (await rustLoop.bgGet(taskId)) as {
        base?: { status?: string };
      };
      expect(settled.base?.status).toBe('completed');
    } finally {
      await klient.close();
    }
  });

  it('interaction list/respond routes question tasks by kind', async () => {
    const klient = createTestKlient();
    try {
      const session = klient.session('ses_interaction_roundtrip');

      // `user_tool` has no engine surface — always empty.
      expect(await session.interactions.list('user_tool')).toEqual([]);

      const registered = await rustLoop.bgRegister({
        prefix: 'question',
        kind: 'question',
        description: 'Pick one?',
      });
      expect(registered?.task_id).toBeTruthy();
      const taskId = registered!.task_id!;

      const pending = await session.interactions.list('question');
      const interaction = pending.find((i) => i.id === taskId);
      expect(interaction).toBeDefined();
      expect(interaction!.kind).toBe('question');
      expect(typeof interaction!.createdAt).toBe('number');

      // respond() routes the pending question interaction to the task
      // settle path (bg/append_output + bg/settle).
      await expect(
        session.interactions.respond(taskId, { answers: { q1: 'a' } }),
      ).resolves.toBeUndefined();
      expect(
        (await session.interactions.list('question')).find((i) => i.id === taskId),
      ).toBeUndefined();
      const settled = (await rustLoop.bgGet(taskId)) as {
        base?: { status?: string };
      };
      expect(settled.base?.status).toBe('completed');
    } finally {
      await klient.close();
    }
  });
});
