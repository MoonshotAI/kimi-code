import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const BROWSER_TOOL = 'mcp__desktop_browser__run';
const TURNED_OFF = 'built-in browser is turned off';
const AVAILABLE = 'built-in browser is available';

scenario(
  'keeps the tool list and the prompt cache prefix when the user turns agent control of the built-in browser off and on again',
  { onlyOn: ['desktop'], reason: 'Only the Desktop app has a built-in browser that agents control.' },
  async ({ product, model }) => {
    model.script(say('The browser is ready.'), say('The browser is off.'), say('The browser is back.'));
    await product.send('Can you use the browser?');
    await product.waitIdle();
    await product.expectReply('The browser is ready.');

    await product.setBrowserControl('off');
    await product.send('Can you still use the browser?');
    await product.waitIdle();
    await product.expectReply('The browser is off.');

    await product.setBrowserControl('on');
    await product.send('And now?');
    await product.waitIdle();
    await product.expectReply('The browser is back.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.tools).toContain(BROWSER_TOOL);
    expect(requests[1]?.remindersSinceReply.join('\n')).toContain(TURNED_OFF);
    expect(requests[2]?.remindersSinceReply.join('\n')).toContain(AVAILABLE);
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
