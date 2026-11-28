import { held, say, write } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const INSTRUCTIONS = '# Copper Finch\n\nRun the tests with make check.\n';

selfTest('init', {
  positive: {
    'returns once the subagent that writes AGENTS.md has started, and the main agent hears what it wrote': {
      run: async ({ product, model, workspace }) => {
        model.script(say('Hello there.'), say('Use the command from AGENTS.md.'));
        model.lane('subagent').script(write({ path: 'AGENTS.md', content: INSTRUCTIONS }), say('AGENTS.md is written.'));
        await product.send('Hello.');
        await product.waitIdle();
        await product.expectReply('Hello there.');
        await product.init();
        await product.approve();
        await product.waitIdle();
        await workspace.expectFile('AGENTS.md', INSTRUCTIONS);
        await product.send('How do I run the tests?');
        await product.waitIdle();
        await product.expectReply('Use the command from AGENTS.md.');
        const reminders = model.requests('main')[1]?.remindersSinceReply.join('\n') ?? '';
        expect(reminders).toContain('The user just ran `/init` slash command.');
        expect(reminders).toContain('Run the tests with make check.');
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      run: async ({ product, model, workspace }) => {
        model.script(held('busy', say('Finished before any init.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.init()).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished before any init.');
        expect(model.requests('subagent')).toHaveLength(0);
        await workspace.expectMissing('AGENTS.md');
      },
    },
  },
});
