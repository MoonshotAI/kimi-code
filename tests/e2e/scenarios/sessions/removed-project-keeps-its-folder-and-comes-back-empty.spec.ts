import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'removes the project from the sidebar without touching its folder, and adding the folder back starts it without the old sessions, as the confirmation says',
  {
    onlyOn: ['web'],
    reason: 'Only the Web interface adds a project through a page dialog; Desktop uses the native folder picker, and the terminal UI and ACP have no list of projects.',
    workspace: { 'notes.txt': 'keep me\n' },
  },
  async ({ product, model, workspace }) => {
    model.script(say('First reply.'), say('Fresh reply.'));

    await product.send('First question');
    await product.expectReply('First reply.');
    await product.waitIdle();
    await product.removeWorkspace();
    await workspace.expectFile('notes.txt', 'keep me\n');

    await product.addWorkspace();
    await product.expectSessions([]);
    await product.send('Fresh question');
    await product.expectReply('Fresh reply.');
    expect(model.requests('main')[1]?.texts('assistant')).toEqual([]);

    await product.waitIdle();
    await product.restart();
    await product.expectReply('Fresh reply.');
    await product.expectSessions(['Fresh question']);
    await workspace.expectFile('notes.txt', 'keep me\n');
  },
);
