import { read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'brings the conversation back after a restart and carries it into the next turn',
  { workspace: { 'notes.txt': 'launch on friday\n' } },
  async ({ product, model, workspace }) => {
    model.script(read('notes.txt'), say('The notes say launch on friday.'), say('You asked me to read notes.txt.'));

    await product.send('Read notes.txt and tell me what it says.');
    await product.waitIdle();
    await product.expectTool({ name: 'Read', target: 'notes.txt', status: 'done' });
    await product.expectReply('The notes say launch on friday.');

    await product.restart();
    await product.expectTranscript('Read notes.txt and tell me what it says.');
    await product.expectTranscript('The notes say launch on friday.');
    expect(model.requests('main')).toHaveLength(2);

    await product.send('What did I ask you before the restart?');
    await product.waitIdle();
    await product.expectReply('You asked me to read notes.txt.');
    const resumed = model.requests('main')[2];
    expect(resumed?.texts('user')).toContain('Read notes.txt and tell me what it says.');
    expect(resumed?.texts('assistant').join('\n')).toContain('The notes say launch on friday.');
    expect(resumed?.texts('tool').join('\n')).toContain('launch on friday');
    await workspace.expectFile('notes.txt', 'launch on friday\n');
  },
);
