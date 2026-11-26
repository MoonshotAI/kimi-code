import { agent, read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the prompt cache prefix for a subagent that uses a tool, and for the main agent before and after it',
  { workspace: { 'notes.txt': 'launch on friday\n' } },
  async ({ product, model, workspace }) => {
    model.script(agent({ prompt: 'Read notes.txt and report what it says.', description: 'read notes' }), say('The helper says the notes mention friday.'), say('Friday it is.'));
    model.lane('subagent').script(read('notes.txt'), say('notes.txt says launch on friday.'));
    await product.send('Ask a helper to read notes.txt.');
    await product.waitIdle();
    await product.expectReply('The helper says the notes mention friday.');
    await product.send('So the launch is on friday?');
    await product.waitIdle();
    await product.expectReply('Friday it is.');

    expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('notes.txt says launch on friday.');
    const entries = model.promptCache();
    const subagent = entries.filter((entry) => entry.role === 'subagent');
    expect(subagent.map((entry) => entry.continues)).toEqual([false, true]);
    expect(subagent.map((entry) => entry.baseline)).toEqual([undefined, subagent[0]?.request]);
    const main = entries.filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(entries.every((entry) => entry.break === undefined)).toBe(true);
    await workspace.expectFile('notes.txt', 'launch on friday\n');
  },
);
