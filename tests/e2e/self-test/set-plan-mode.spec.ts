import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const PLAN_ON = 'Plan mode is active';
const PLAN_OFF = 'Plan mode is no longer active';

selfTest('setPlanMode', {
  positive: {
    'turns plan mode on, so the next request tells the model that plan mode is active': {
      run: async ({ product, model }) => {
        model.script(say('Hello there.'), say('Here is how I would plan it.'));
        await product.send('Hello.');
        await product.waitIdle();
        await product.setPlanMode('on');
        await product.send('How would you add a cache?');
        await product.waitIdle();
        await product.expectReply('Here is how I would plan it.');
        const requests = model.requests('main');
        expect(requests[0]?.remindersSinceReply.join('\n')).not.toContain(PLAN_ON);
        expect(requests[1]?.remindersSinceReply.join('\n')).toContain(PLAN_ON);
      },
    },
    'turns plan mode off again, so the next request tells the model that plan mode has ended': {
      run: async ({ product, model }) => {
        model.script(say('Hello there.'), say('Here is how I would plan it.'), say('Back to normal.'));
        await product.send('Hello.');
        await product.waitIdle();
        await product.setPlanMode('on');
        await product.send('How would you add a cache?');
        await product.waitIdle();
        await product.setPlanMode('off');
        await product.send('Thanks, that is all.');
        await product.waitIdle();
        await product.expectReply('Back to normal.');
        const reminders = model.requests('main')[2]?.remindersSinceReply.join('\n');
        expect(reminders).toContain(PLAN_OFF);
        expect(reminders).not.toContain(PLAN_ON);
      },
    },
    'turns plan mode off before any message was sent in it': {
      run: async ({ product, model }) => {
        model.script(say('Hello there.'), say('No plan this time.'));
        await product.send('Hello.');
        await product.waitIdle();
        await product.setPlanMode('on');
        await product.setPlanMode('off');
        await product.send('Just answer, please.');
        await product.waitIdle();
        await product.expectReply('No plan this time.');
        expect(model.requests('main')[1]?.remindersSinceReply.join('\n')).not.toContain(PLAN_ON);
      },
    },
  },
  negative: {
    'fails when plan mode is already on': {
      run: async ({ product, model }) => {
        model.script(say('Hello there.'), say('Still planning.'));
        await product.send('Hello.');
        await product.waitIdle();
        await product.setPlanMode('on');
        await expect(product.setPlanMode('on')).rejects.toThrow('already on');
        await product.send('Are you still planning?');
        await product.waitIdle();
        await product.expectReply('Still planning.');
        expect(model.requests('main')[1]?.remindersSinceReply.join('\n')).toContain(PLAN_ON);
      },
    },
    'fails when plan mode is already off': {
      run: async ({ product, model }) => {
        await expect(product.setPlanMode('off')).rejects.toThrow('already off');
        model.script(say('Not planning.'));
        await product.send('Are you planning?');
        await product.waitIdle();
        await product.expectReply('Not planning.');
        expect(model.requests('main')[0]?.remindersSinceReply.join('\n')).not.toContain(PLAN_ON);
      },
    },
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished without a plan.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.setPlanMode('on')).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished without a plan.');
        expect(model.requests('main')[0]?.remindersSinceReply.join('\n')).not.toContain(PLAN_ON);
      },
    },
  },
});
