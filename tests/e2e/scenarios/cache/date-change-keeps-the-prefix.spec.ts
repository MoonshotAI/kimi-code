import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const FIRST_DAY = '2030-01-01T12:00:00Z';
const NEXT_DAY = '2030-01-02T12:00:00Z';
const localDate = (time: string): string => new Date(time).toLocaleDateString('en-CA');

scenario(
  'keeps the prompt cache prefix, also after a restart, when the local date changes in the middle of a session',
  { clock: FIRST_DAY },
  async ({ product, model, clock }) => {
    model.script(say('Good morning.'), say('A new day has started.'), say('Still the same new day.'));
    await product.send('Good morning.');
    await product.waitIdle();
    await product.expectReply('Good morning.');

    await clock(NEXT_DAY);
    await product.send('Is it a new day?');
    await product.waitIdle();
    await product.expectReply('A new day has started.');

    await product.restart();
    await product.send('And now?');
    await product.waitIdle();
    await product.expectReply('Still the same new day.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.remindersSinceReply.join('\n')).toContain(localDate(FIRST_DAY));
    expect(requests[1]?.remindersSinceReply.join('\n')).toContain(localDate(NEXT_DAY));
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
