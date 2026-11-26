import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const rule = 'Always answer in one line.';

scenario(
  'keeps the system prompt and the prompt cache prefix, also after a restart, when the user writes AGENTS.md in the middle of a session',
  {},
  async ({ product, model, workspace }) => {
    model.script(say('Ready.'), say('Noted.'), say('Still here.'));
    await product.send('Get ready.');
    await product.waitIdle();
    await product.expectReply('Ready.');

    await workspace.write('AGENTS.md', `${rule}\n`);
    await product.send('I added project instructions.');
    await product.waitIdle();
    await product.expectReply('Noted.');

    await product.restart();
    await product.send('Are you still there?');
    await product.waitIdle();
    await product.expectReply('Still here.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.view.system).not.toContain(rule);
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
    await workspace.expectFile('AGENTS.md', `${rule}\n`);
  },
);
