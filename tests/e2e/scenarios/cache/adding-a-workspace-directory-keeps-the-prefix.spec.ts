import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const ADDED = /Added directories: .*docs\./;

scenario(
  'keeps the system prompt, the tool list and the prompt cache prefix, also after a restart, when the user adds a workspace directory with /add-dir',
  {
    workspace: { 'docs/guide.md': '# Guide\n' },
    onlyOn: ['tui'],
    reason: 'Only the terminal UI has /add-dir; Desktop and the web UI add a directory to the whole project, and ACP cannot add one to a running session.',
  },
  async ({ product, model }) => {
    model.script(say('Ready.'), say('The docs directory is in the workspace now.'), say('Still the same workspace.'));
    await product.send('Are you ready?');
    await product.waitIdle();
    await product.expectReply('Ready.');

    await product.addDir('docs');
    await product.send('Which directories can you use?');
    await product.waitIdle();
    await product.expectReply('The docs directory is in the workspace now.');

    await product.restart();
    await product.send('And after the restart?');
    await product.waitIdle();
    await product.expectReply('Still the same workspace.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    const announced = requests.map((request) => ADDED.test(request.remindersSinceReply.join('\n')));
    expect(announced[0]).toBe(false);
    expect(announced.slice(1)).toContain(true);
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
