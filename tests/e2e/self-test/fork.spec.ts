import { say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('fork', {
  positive: {
    'opens a fork that carries the conversation so far and keeps its own messages': {
      run: async ({ product, model }) => {
        model.script(say('The shared answer.'), say('Answered in the fork.'));
        await product.send('Ask the shared question.');
        await product.waitIdle();
        await product.fork();
        await product.expectSessions(['Ask the shared question.', 'Fork: Ask the shared question.']);
        await product.expectTranscript('The shared answer.');
        await product.send('Ask in the fork.');
        await product.waitIdle();
        await product.expectReply('Answered in the fork.');
        const inFork = model.requests('main')[1];
        expect(inFork?.texts('assistant')).toEqual(['The shared answer.']);
        expect(inFork?.userTextsSinceReply).toEqual(['Ask in the fork.']);
      },
    },
  },
  negative: {
    'fails when the session has no messages yet': {
      run: async ({ product, model }) => {
        await expect(product.fork()).rejects.toThrow('needs a session with messages');
        model.script(say('Nothing was forked.'));
        await product.send('Did anything fork?');
        await product.waitIdle();
        await product.expectReply('Nothing was forked.');
      },
    },
  },
});
