import { finishWith, held, say } from '@moonshot-ai/testkit/model';
import { describe, expect, test as base } from 'vitest';

import { abortError } from '#/_base/utils/abort';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { drainSessionMetadataWrites } from '#/session/sessionMetadata/sessionMetadataService';

import { testkitAgentFixtures, type TestkitAgentFixtures } from '../../harness';

const test = base.extend<TestkitAgentFixtures>(testkitAgentFixtures());

describe('SessionActivityView and SessionOutcomeMirror (testkit engine)', () => {
  test(
    'tracks live activity and mirrors terminal outcomes across completion, cancel, abort, gate-block, failure, steer, and promptOnly',
    async ({ agent, model }) => {
      await agent.restorePersisted();
      const activity = agent.get(ISessionActivityView);
      const metadata = agent.get(ISessionMetadata);
      const loop = agent.get(IAgentLoopService);
      const mirrored = async () => {
        await drainSessionMetadataWrites();
        return (await metadata.read()).lastTurnReason;
      };

      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: undefined });
      await expect(mirrored()).resolves.toBeUndefined();

      model.script(say('First answer.'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'complete' }] });
      await agent.untilTurnEnd();
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'completed' });
      await expect(mirrored()).resolves.toBe('completed');

      model.script(held('user-cancel', say('Streaming until cancelled.'), 1));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'cancel me' }] });
      await model.hold('user-cancel').reached();
      expect(activity.state()).toMatchObject({ busy: true, mainTurnActive: true, lastTurnReason: undefined });
      await expect(mirrored()).resolves.toBeUndefined();
      expect(loop.cancel()).toBe(true);
      await agent.untilTurnEnd();
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'cancelled' });
      await expect(mirrored()).resolves.toBe('cancelled');

      model.script(held('parent-abort', say('Streaming until parent aborts.'), 1));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'abort me' }] });
      await model.hold('parent-abort').reached();
      expect(activity.state()).toMatchObject({ busy: true, mainTurnActive: true, lastTurnReason: undefined });
      expect(loop.cancel(undefined, abortError('parent aborted'))).toBe(true);
      await agent.untilTurnEnd();
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'cancelled' });
      await expect(mirrored()).resolves.toBeUndefined();

      const gate = loop.hooks.onBeforeSubmitPrompt.register('test-gate-block', async (ctx, next) => {
        ctx.block = true;
        await next();
      });
      try {
        await expect(
          loop.submit({ input: [{ type: 'text', text: 'blocked by gate' }], promptId: 'blocked-prompt' }),
        ).resolves.toBeUndefined();
        await expect(loop.promptHandle('blocked-prompt')!.completion).resolves.toMatchObject({ state: 'blocked' });
      } finally {
        gate.dispose();
      }
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'cancelled' });
      await expect(mirrored()).resolves.toBeUndefined();

      model.script(finishWith('filtered', say('blocked content')));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'filtered' }] });
      await agent.untilTurnEnd();
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'failed' });
      await expect(mirrored()).resolves.toBe('failed');

      model.script(held('steer-hold', say('Streaming before steer.'), 1), say('Answer after steer.'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'steer target' }] });
      await model.hold('steer-hold').reached();
      const steered = loop.sendNow({ role: 'user', content: [{ type: 'text', text: 'steer follow-up' }] });
      await expect(loop.promptHandle(steered.id)!.completion).resolves.toMatchObject({ state: 'completed' });
      await loop.settled();
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'completed' });
      await expect(mirrored()).resolves.toBe('completed');

      const notification = loop.notify({
        role: 'user',
        content: [{ type: 'text', text: 'prompt-only note' }],
        attributes: { promptOnly: true },
      });
      await expect(loop.promptHandle(notification.id)!.completion).resolves.toMatchObject({ state: 'completed' });
      await loop.settled();
      expect(activity.state()).toMatchObject({ busy: false, mainTurnActive: false, lastTurnReason: 'completed' });
      await expect(mirrored()).resolves.toBe('completed');
      expect(model.requests('main')).toHaveLength(6);

      await agent.expectResumeMatches();
    },
  );
});
