import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const instructions = 'Use the project name Copper Finch in summaries.\n';

scenario(
  'keeps the prompt cache prefix across turns and a restart after the user trusts a new folder',
  {
    onlyOn: ['tui'],
    reason: 'The TUI presents a workspace trust dialog before opening the conversation.',
    workspace: { 'AGENTS.md': instructions },
    workspaceTrust: 'trust',
  },
  async ({ product, model, workspace }) => {
    model.script(say('Copper Finch is ready.'), say('Copper Finch has two modules.'), say('Copper Finch ships on friday.'));
    await product.send('Summarize this project.');
    await product.waitIdle();
    await product.expectReply('Copper Finch is ready.');
    await product.send('How many modules does it have?');
    await product.waitIdle();
    await product.expectReply('Copper Finch has two modules.');

    await product.restart();
    await product.send('When does it ship?');
    await product.waitIdle();
    await product.expectReply('Copper Finch ships on friday.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.view.system.includes(instructions.trim()))).toBe(true);
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.slice(1).map((entry) => entry.baseline)).toEqual(main.slice(0, -1).map((entry) => entry.request));
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
    await workspace.expectFile('AGENTS.md', instructions);
  },
);
