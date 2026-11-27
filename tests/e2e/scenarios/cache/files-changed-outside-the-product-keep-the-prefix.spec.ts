import { read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the prompt cache prefix after the user changes and adds workspace files outside the product between two turns',
  { workspace: { 'notes.txt': 'draft one\n' } },
  async ({ product, model, workspace }) => {
    model.script(read('notes.txt'), say('The notes say draft one.'));
    await product.send('Read notes.txt.');
    await product.waitIdle();
    await product.expectTool({ name: 'Read', target: 'notes.txt', status: 'done' });
    await product.expectReply('The notes say draft one.');

    await workspace.write('notes.txt', 'draft two\n');
    await workspace.write('todo.txt', 'ship it\n');

    model.script(read('notes.txt'), say('The notes now say draft two.'));
    await product.send('Read notes.txt again.');
    await product.waitIdle();
    await product.expectReply('The notes now say draft two.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(4);
    expect(requests[3]?.texts('tool').join('\n')).toContain('draft two');
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.slice(1).map((entry) => entry.baseline)).toEqual(main.slice(0, -1).map((entry) => entry.request));
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
    await workspace.expectFile('notes.txt', 'draft two\n');
    await workspace.expectFile('todo.txt', 'ship it\n');
  },
);
