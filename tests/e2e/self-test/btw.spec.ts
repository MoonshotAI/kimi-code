import { held, httpError, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const SIDE_QUESTION = 'How long does a build take?';
const SIDE_REPLY = 'A build takes about ten minutes.';

selfTest('btw', {
  positive: {
    'asks a side question, shows the side answer and leaves the main conversation as it was': {
      run: async ({ product, model }) => {
        model.script(say('The build uses pnpm.'), say('Run pnpm install first.'));
        model.lane('subagent').script(say(SIDE_REPLY));
        await product.send('Which package manager does the build use?');
        await product.waitIdle();
        await product.btw(SIDE_QUESTION, SIDE_REPLY);
        await product.send('What should I run first?');
        await product.waitIdle();
        await product.expectReply('Run pnpm install first.');
        expect(model.requests('subagent').at(-1)?.texts('user')).toContain(SIDE_QUESTION);
        const next = model.requests('main')[1];
        expect(next?.texts('user')).not.toContain(SIDE_QUESTION);
        expect(next?.texts('assistant')).not.toContain(SIDE_REPLY);
      },
    },
    'waits for a side answer that streams in several parts before closing the side view': {
      run: async ({ product, model }) => {
        model.script(say('The build uses pnpm.'), say('Run pnpm install first.'));
        model.lane('subagent').script(say(['A build takes ', 'about ten minutes.'], { intervalMs: 300 }));
        await product.send('Which package manager does the build use?');
        await product.waitIdle();
        await product.btw(SIDE_QUESTION, SIDE_REPLY);
        await product.send('What should I run first?');
        await product.waitIdle();
        await product.expectReply('Run pnpm install first.');
        expect(model.requests('subagent')).toHaveLength(1);
      },
    },
    'asks a second side question after the first one is closed': {
      run: async ({ product, model }) => {
        model.script(say('The build uses pnpm.'), say('That is all for now.'));
        model.lane('subagent').script(say(SIDE_REPLY), say('The tests take two minutes.'));
        await product.send('Which package manager does the build use?');
        await product.waitIdle();
        await product.btw(SIDE_QUESTION, SIDE_REPLY);
        await product.btw('How long do the tests take?', 'The tests take two minutes.');
        await product.send('Anything else?');
        await product.waitIdle();
        await product.expectReply('That is all for now.');
        const second = model.requests('subagent').at(-1);
        expect(second?.texts('user')).toContain('How long do the tests take?');
        expect(second?.texts('user')).not.toContain(SIDE_QUESTION);
      },
    },
  },
  negative: {
    'fails when the model service refuses the side question, and closes the side view so the main conversation goes on': {
      run: async ({ product, model }) => {
        model.script(say('The build uses pnpm.'), say('Run pnpm install first.'));
        model.lane('subagent').script(httpError(400, { message: 'The example service refused the side question.' }));
        await product.send('Which package manager does the build use?');
        await product.waitIdle();
        await expect(product.btw(SIDE_QUESTION, SIDE_REPLY)).rejects.toThrow('ended without');
        await product.send('What should I run first?');
        await product.waitIdle();
        await product.expectReply('Run pnpm install first.');
        expect(model.requests('subagent')).toHaveLength(1);
      },
    },
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished before any side question.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.btw(SIDE_QUESTION, SIDE_REPLY)).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished before any side question.');
        expect(model.requests('subagent')).toHaveLength(0);
      },
    },
  },
});
