import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

const BROWSER_TOOL = 'mcp__desktop_browser__run';
const TURNED_OFF = 'built-in browser is turned off';
const AVAILABLE = 'built-in browser is available';

selfTest('setBrowserControl', {
  positive: {
    'turns agent control off, so the next request tells the model the browser is off': {
      run: async ({ product, model }) => {
        model.script(say('The browser is ready.'), say('The browser is off.'));
        await product.send('Can you use the browser?');
        await product.waitIdle();
        await product.setBrowserControl('off');
        await product.send('Can you still use the browser?');
        await product.waitIdle();
        await product.expectReply('The browser is off.');
        const requests = model.requests('main');
        expect(requests[0]?.tools).toContain(BROWSER_TOOL);
        expect(requests[0]?.remindersSinceReply.join('\n')).not.toContain(TURNED_OFF);
        expect(requests[1]?.remindersSinceReply.join('\n')).toContain(TURNED_OFF);
      },
    },
    'turns agent control back on, so the next request tells the model the browser is back': {
      run: async ({ product, model }) => {
        model.script(say('The browser is ready.'), say('The browser is off.'), say('The browser is back.'));
        await product.send('Can you use the browser?');
        await product.waitIdle();
        await product.setBrowserControl('off');
        await product.send('Can you still use the browser?');
        await product.waitIdle();
        await product.setBrowserControl('on');
        await product.send('And now?');
        await product.waitIdle();
        await product.expectReply('The browser is back.');
        const reminders = model.requests('main')[2]?.remindersSinceReply.join('\n');
        expect(reminders).toContain(AVAILABLE);
        expect(reminders).not.toContain(TURNED_OFF);
      },
    },
  },
  negative: {
    'fails when agent control is already in that state': {
      run: async ({ product, model }) => {
        await expect(product.setBrowserControl('on')).rejects.toThrow('already on');
        model.script(say('The browser is still ready.'));
        await product.send('Can you use the browser?');
        await product.waitIdle();
        await product.expectReply('The browser is still ready.');
        const first = model.requests('main')[0];
        expect(first?.tools).toContain(BROWSER_TOOL);
        expect(first?.remindersSinceReply.join('\n')).not.toContain(TURNED_OFF);
      },
    },
    'fails while a turn is running': {
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished with the browser still on.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.setBrowserControl('off')).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished with the browser still on.');
      },
    },
  },
});
