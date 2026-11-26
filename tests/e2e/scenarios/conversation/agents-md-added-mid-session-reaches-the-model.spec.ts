import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const ADDED_AGENTS_MD = 'The following AGENTS.md file(s) exist in your workspace but were not included in your system prompt';

scenario(
  'tells the model in the very next request about an AGENTS.md the user adds mid-session, and keeps the prompt cache prefix',
  {},
  async ({ product, model, workspace }) => {
    model.script(say('First answer.'));
    await product.send('Say hello.');
    await product.waitIdle();
    await product.expectReply('First answer.');

    await workspace.write('AGENTS.md', 'Always answer in one line.\n');

    model.script(say('Second answer.'));
    await product.send('Say hello again.');
    await product.waitIdle();
    await product.expectReply('Second answer.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.remindersSinceReply.join('\n')).not.toContain(ADDED_AGENTS_MD);
    expect(requests[1]?.remindersSinceReply.join('\n')).toContain(ADDED_AGENTS_MD);
    expect(requests[1]?.view.system).toBe(requests[0]?.view.system);
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main[1]?.baseline).toEqual(main[0]?.request);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);

scenario(
  'tells the model after a restart about an AGENTS.md the user added just before it',
  {},
  async ({ product, model, workspace }) => {
    model.script(say('First answer.'));
    await product.send('Say hello.');
    await product.waitIdle();
    await product.expectReply('First answer.');

    await workspace.write('AGENTS.md', 'Always answer in one line.\n');
    await product.restart();

    model.script(say('Second answer.'));
    await product.send('Say hello again.');
    await product.waitIdle();
    await product.expectReply('Second answer.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.remindersSinceReply.join('\n')).toContain(ADDED_AGENTS_MD);
    expect(requests[1]?.view.system).toBe(requests[0]?.view.system);
  },
);
