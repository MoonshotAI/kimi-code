/**
 * Dual-backend rewrite of scenario `02-tool-call-with-approval`: a Bash tool
 * call blocks on a manual approval; the client lists and approves it through
 * the session facade, and the turn completes with the canary in the output.
 */
import { expect, it } from 'vitest';

import { DUAL_MODEL_ID, defineDualSuite, onceEvent } from '../../helpers/dual.js';

defineDualSuite('tool call approval', { requiresModel: true }, ({ klient }) => {
  it(
    'approval requested → listed → approved → prompt completes',
    async () => {
      const k = klient();
      const canary = `DUAL_APPROVAL_${process.pid}_${Date.now()}`;
      const session = await k.global.sessions.create({ workDir: process.cwd() });
      const handle = k.session(session.id);
      const agent = handle.agent('main');
      await agent.setModel(DUAL_MODEL_ID);
      await agent.setPermission('manual');

      const outputs: string[] = [];
      agent.events.on('tool.result', (event) => {
        outputs.push(JSON.stringify(event.output));
      });
      const approvalRequested = onceEvent(agent.events, 'permission.approval.requested', 180_000);
      const completed = onceEvent(agent.events, 'prompt.completed', 240_000);

      await agent.prompt({
        input: [
          {
            type: 'text',
            text: `Use the Bash tool to run \`echo ${canary}\` and then report the output back.`,
          },
        ],
      });

      const requested = await approvalRequested;
      expect(requested.toolName.length).toBeGreaterThan(0);

      const pending = await handle.approvals.list();
      expect(pending.length).toBeGreaterThan(0);
      const target = pending[0]!;
      await handle.approvals.decide(target.id ?? target.toolCallId ?? '', {
        decision: 'approved',
      });
      expect(await handle.approvals.list()).toHaveLength(0);

      await completed;
      expect(outputs.join('\n')).toContain(canary);

      await handle.archive();
    },
    300_000,
  );
});
