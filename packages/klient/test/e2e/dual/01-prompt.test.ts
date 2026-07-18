/**
 * Dual-backend rewrite of scenario `01-create-and-send`: create a session,
 * run one prompt to completion, and assert the assistant replied — driven
 * entirely through the klient facade + agent events, on both backends.
 */
import { expect, it } from 'vitest';

import { DUAL_MODEL_ID, defineDualSuite, onceEvent } from '../../helpers/dual.js';

defineDualSuite('prompt round-trip', { requiresModel: true }, ({ klient }) => {
  it(
    'creates a session, runs a prompt, and accumulates the assistant reply',
    async () => {
      const k = klient();
      const session = await k.global.sessions.create({ workDir: process.cwd() });
      const handle = k.session(session.id);
      const agent = handle.agent('main');
      await agent.setModel(DUAL_MODEL_ID);

      const deltas: string[] = [];
      agent.events.on('assistant.delta', (event) => {
        deltas.push(event.delta);
      });
      const completed = onceEvent(agent.events, 'prompt.completed', 120_000);
      const launched = await agent.prompt({
        input: [{ type: 'text', text: 'Reply with the single word "OK" and nothing else.' }],
      });
      expect(launched).toBeTruthy();

      await completed;
      expect(deltas.join('')).toContain('OK');

      await handle.archive();
      expect((await k.global.sessions.get(session.id))?.archived).toBe(true);
    },
    180_000,
  );
});
