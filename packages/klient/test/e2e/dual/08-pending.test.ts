/**
 * Dual-backend rewrite of scenario `08-pending-recovery`: pending approval
 * and question interactions are listed and resolved through the session
 * facade, letting the blocked prompts run to completion.
 */
import { expect, it } from 'vitest';

import { DUAL_MODEL_ID, defineDualSuite, onceEvent, waitFor } from '../../helpers/dual.js';

defineDualSuite('pending interaction recovery', { requiresModel: true }, ({ klient }) => {
  it(
    'approval pending → approve → completes; question pending → answer → completes',
    async () => {
      const k = klient();
      const canary = `DUAL_PENDING_${process.pid}_${Date.now()}`;
      const session = await k.global.sessions.create({ workDir: process.cwd() });
      const handle = k.session(session.id);
      const agent = handle.agent('main');
      await agent.setModel(DUAL_MODEL_ID);
      await agent.setPermission('manual');

      // --- approval recovery ---
      let completed = onceEvent(agent.events, 'prompt.completed', 240_000);
      await agent.prompt({
        input: [
          { type: 'text', text: `Use the Bash tool to run \`echo ${canary}\` and report the output.` },
        ],
      });
      await waitFor(() => handle.approvals.list().then((l) => l.length > 0), 180_000);
      const approval = (await handle.approvals.list())[0]!;
      await handle.approvals.decide(approval.id ?? approval.toolCallId ?? '', {
        decision: 'approved',
      });
      expect(await handle.approvals.list()).toHaveLength(0);
      await completed;

      // --- question recovery ---
      completed = onceEvent(agent.events, 'prompt.completed', 240_000);
      await agent.prompt({
        input: [
          {
            type: 'text',
            text:
              'Call the AskUserQuestion tool exactly once with one question ("Pick one") ' +
              'and exactly two options ("Alpha", "Beta"), then stop and wait for the answer.',
          },
        ],
      });
      await waitFor(() => handle.questions.list().then((l) => l.length > 0), 180_000);
      const question = (await handle.questions.list())[0]!;
      const item = question.questions[0]!;
      const firstLabel = item.options[0]!.label;
      await handle.questions.answer(question.id ?? question.toolCallId ?? '', {
        [item.question]: firstLabel,
      });
      expect(await handle.questions.list()).toHaveLength(0);
      await completed;

      await handle.archive();
    },
    480_000,
  );
});
