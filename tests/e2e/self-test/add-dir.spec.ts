import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const ADDED = /Added directories: .*docs\./;

selfTest('addDir', {
  positive: {
    'adds the directory for this session, so the next request tells the model about it': {
      workspace: { 'docs/guide.md': '# Guide\n' },
      run: async ({ product, model }) => {
        model.script(say('Ready.'), say('The docs directory is in the workspace now.'));
        await product.send('Are you ready?');
        await product.waitIdle();
        await product.addDir('docs');
        await product.send('Which directories can you use?');
        await product.waitIdle();
        await product.expectReply('The docs directory is in the workspace now.');
        const requests = model.requests('main');
        expect(requests[0]?.remindersSinceReply.join('\n')).not.toMatch(ADDED);
        expect(requests[1]?.remindersSinceReply.join('\n')).toMatch(ADDED);
      },
    },
  },
  negative: {
    'fails when the directory does not exist': {
      run: async ({ product, model }) => {
        model.script(say('Ready.'), say('Nothing was added.'));
        await product.send('Are you ready?');
        await product.waitIdle();
        await expect(product.addDir('missing')).rejects.toThrow('refuse to add "missing"');
        await product.send('Was anything added?');
        await product.waitIdle();
        await product.expectReply('Nothing was added.');
        expect(model.requests('main')[1]?.remindersSinceReply.join('\n')).not.toContain('Added directories:');
      },
    },
    'fails while a turn is running': {
      workspace: { 'docs/guide.md': '# Guide\n' },
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished before any directory was added.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.addDir('docs')).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished before any directory was added.');
      },
    },
  },
});
