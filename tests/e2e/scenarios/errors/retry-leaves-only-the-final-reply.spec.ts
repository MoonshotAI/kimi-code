import { held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'replaces a reply cut off mid-stream with the retried one',
  {
    except: {
      acp: 'Product gap, left out until the owner decides how ACP separates a retried reply: the editor still receives the cut part and the retried reply as one message.',
    },
  },
  async ({ product, model }) => {
    const draft = 'Draft answer that gets cut';
    model.script(held('mid', say(['Draft answer ', 'that gets cut', ' x']), 2), say('Final answer after the retry.'));

    await product.send('Summarise the project status.');
    await model.hold('mid').reached();
    await product.expectReply(draft);
    model.hold('mid').cut();
    await product.waitIdle();

    expect(model.requests('main').map((request) => request.state)).toEqual(['cut', 'finished']);
    await product.expectReply('Final answer after the retry.');
    await product.expectAbsent(draft);
  },
);
