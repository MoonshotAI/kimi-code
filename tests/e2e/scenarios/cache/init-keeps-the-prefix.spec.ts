import { say, write } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const INSTRUCTIONS = '# Copper Finch\n\nRun the tests with make check.\n';

scenario(
  'keeps the system prompt, the tool list and the prompt cache prefix after the user generates AGENTS.md with /init and goes on',
  {
    onlyOn: ['tui'],
    reason: 'Only the terminal UI offers /init; the Desktop and Web slash menus and kimi acp have no command that generates AGENTS.md.',
  },
  async ({ product, model, workspace }) => {
    model.script(say('Hello there.'), say('Run make check.'), say('It is called Copper Finch.'));
    model.lane('subagent').script(write({ path: 'AGENTS.md', content: INSTRUCTIONS }), say('AGENTS.md is written.'));
    await product.send('Hello.');
    await product.waitIdle();
    await product.expectReply('Hello there.');

    await product.init();
    await product.approve();
    await product.waitIdle();
    await workspace.expectFile('AGENTS.md', INSTRUCTIONS);

    await product.send('How do I run the tests?');
    await product.waitIdle();
    await product.expectReply('Run make check.');
    await product.send('What is the project called?');
    await product.waitIdle();
    await product.expectReply('It is called Copper Finch.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    const told = requests[1]?.remindersSinceReply.join('\n') ?? '';
    expect(told).toContain('The user just ran `/init` slash command.');
    expect(told).toContain('Run the tests with make check.');
    expect(requests[0]?.view.system).not.toContain('Run the tests with make check.');
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
