import { read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the prompt cache prefix when the user switches the git branch in a terminal between two turns',
  {
    workspace: { 'notes.txt': 'alpha\n' },
    git: { branches: { feature: { 'notes.txt': 'beta\n' } } },
  },
  async ({ product, model, workspace }) => {
    model.script(read('notes.txt'), say('It says alpha.'), read('notes.txt'), say('Now it says beta.'));

    await product.send('What does notes.txt say?');
    await product.waitIdle();
    await product.expectReply('It says alpha.');

    await workspace.git(['checkout', '-q', 'feature']);
    await workspace.expectFile('notes.txt', 'beta\n');
    await product.send('Read notes.txt again.');
    await product.waitIdle();
    await product.expectReply('Now it says beta.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(4);
    expect(requests[1]?.texts('tool').join('\n')).toContain('alpha');
    expect(requests[3]?.texts('tool').join('\n')).toContain('beta');
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request, main[2]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
