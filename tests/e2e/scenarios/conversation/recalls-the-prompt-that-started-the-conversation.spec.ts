import { say } from '@moonshot-ai/testkit/model';

import { scenario } from '../../support/scenario';

scenario(
  'recalls the prompt that started the conversation with the up key',
  { except: { acp: 'An editor writes prompts in its own input and keeps its own prompt history.' } },
  async ({ product, model }) => {
    const opener = 'Start with this question.';
    model.script(say('Here is the answer.'));

    await product.send(opener);
    await product.waitIdle();
    await product.expectReply('Here is the answer.');
    await product.recallPrevious();
    await product.expectComposer(opener);
  },
);
