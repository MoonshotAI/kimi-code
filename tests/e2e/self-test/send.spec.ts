import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest, selfTestCase } from '../support/scenario';

selfTest('send', {
  positive: {
    'shows the user message and delivers the same text to the model': {
      run: async ({ product, model }) => {
        model.script(say('Received.'));
        await product.send('Tell me that you received this.');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.firstUserText)).toEqual(['Tell me that you received this.']);
        await product.expectReply('Received.');
      },
    },
    'shows a prompt typed in Chinese and delivers the same text to the model': {
      run: async ({ product, model }) => {
        model.script(say('收到了。'));
        await product.send('请确认你收到了这条消息。');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.firstUserText)).toEqual(['请确认你收到了这条消息。']);
        await product.expectTranscript('请确认你收到了这条消息。');
        await product.expectReply('收到了。');
      },
    },
    'tells a repeated prompt from the earlier one after a long answer': {
      run: async ({ product, model }) => {
        const long = Array.from({ length: 80 }, (_, index) => `Paragraph number ${index + 1}.`).join('\n\n');
        model.script(say(long), say('Second answer.'));
        await product.send('Answer me.');
        await product.waitIdle();
        await product.expectReply('Paragraph number 80.');
        await product.send('Answer me.');
        await product.waitIdle();
        expect(model.requests('main')).toHaveLength(2);
        await product.expectReply('Second answer.');
      },
    },
  },
  negative: {
    'refuses to type over a prompt already in the input': selfTestCase(
      { except: { acp: "An editor keeps its own input, so an ACP prompt never lands on top of the user's text." } },
      async ({ product, model }) => {
        model.script(say('Answered.'));
        await product.send('The prompt that undo brings back.');
        await product.waitIdle();
        await product.undo();
        await expect(product.send('A new prompt.')).rejects.toThrow('needs an empty');
        await product.expectComposer('The prompt that undo brings back.');
      },
    ),
    'refuses a prompt that the product would read as a command': {
      run: async ({ product, model }) => {
        await expect(product.send('/help')).rejects.toThrow('cannot take a prompt that starts with');
        await expect(product.send('!ls')).rejects.toThrow('cannot take a prompt that starts with');
        await expect(product.send('@a.txt')).rejects.toThrow('cannot take a prompt that starts with');
        await expect(product.send('two\nlines')).rejects.toThrow('one line of printable text');
        await expect(product.send('Ends with a backslash \\')).rejects.toThrow('cannot end with a backslash');
        model.script(say('Still here.'));
        await product.send('Are you still there?');
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.firstUserText)).toEqual(['Are you still there?']);
        await product.expectReply('Still here.');
      },
    },
    'refuses to send while a turn is still running': {
      run: async ({ product, model }) => {
        model.script(held('reply', say('First answer.')));
        await product.send('Answer slowly.');
        await model.hold('reply').reached();
        await expect(product.send('Second prompt.')).rejects.toThrow('needs an idle product');
        model.hold('reply').release();
        await product.waitIdle();
        expect(model.requests('main').map((request) => request.firstUserText)).toEqual(['Answer slowly.']);
        await product.expectReply('First answer.');
      },
    },
  },
});
