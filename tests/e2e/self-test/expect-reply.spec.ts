import { read, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectReply', {
  positive: {
    'finds the text the assistant replied with': {
      run: async ({ product, model }) => {
        model.script(say('The sky is blue.'));
        await product.send('What colour is the sky?');
        await product.waitIdle();
        await product.expectReply('The sky is blue.');
      },
    },
  },
  negative: {
    'fails when the assistant replied with something else': {
      run: async ({ product, model }) => {
        model.script(say('The grass is green.'));
        await product.send('What colour is the sky?');
        await product.waitIdle();
        await expect(product.expectReply('The sky is blue.')).rejects.toThrow('did not find "The sky is blue."');
        await product.expectReply('The grass is green.');
      },
    },
    'does not take a tool card for a reply': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I looked at the file.'));
        await product.send('Look at the file.');
        await product.waitIdle();
        await expect(product.expectReply('Used Read (a.txt)')).rejects.toThrow('did not find "Used Read (a.txt)"');
        await expect(product.expectReply('a.txt')).rejects.toThrow('did not find "a.txt"');
        await product.expectReply('I looked at the file.');
      },
    },
    'does not take a reply from an earlier turn': {
      run: async ({ product, model }) => {
        model.script(say('The first answer.'), say('The second answer.'));
        await product.send('Ask once.');
        await product.waitIdle();
        await product.expectReply('The first answer.');
        await product.send('Ask again.');
        await product.waitIdle();
        await expect(product.expectReply('The first answer.')).rejects.toThrow('did not find "The first answer."');
        await product.expectReply('The second answer.');
      },
    },
    'does not take the prompt the user typed for a reply': {
      run: async ({ product, model }) => {
        model.script(say('Noted.'));
        await product.send('Repeat after me: the sky is blue.');
        await product.waitIdle();
        await expect(product.expectReply('the sky is blue')).rejects.toThrow('did not find "the sky is blue"');
        await product.expectReply('Noted.');
      },
    },
  },
});
