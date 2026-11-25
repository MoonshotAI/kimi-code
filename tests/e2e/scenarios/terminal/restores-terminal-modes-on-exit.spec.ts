import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'gives the shell its terminal back in normal mode after the user exits',
  { onlyOn: ['tui'], reason: 'Only the terminal UI runs inside the user’s own shell and changes its terminal modes.' },
  async ({ product, model }) => {
    model.script(say('All done here.'));

    await product.send('Finish up.');
    await product.waitIdle();
    await product.expectReply('All done here.');
    expect(model.requests('main')[0]?.firstUserText).toBe('Finish up.');

    await product.exit();
    await product.expectTerminalRestored();
  },
);
