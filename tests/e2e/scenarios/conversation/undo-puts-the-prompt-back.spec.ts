import { edit, read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'puts an undone prompt back in the input, keeps its file change, and leaves the undone turn out of the next request',
  {
    except: { acp: 'ACP has no request to withdraw a message, and an editor keeps its own input.' },
    workspace: { 'notes.txt': 'draft\n' },
  },
  async ({ product, model, workspace }) => {
    const first = 'What does notes.txt say?';
    const second = 'Change draft to final in notes.txt.';
    model.script(
      read('notes.txt'),
      say('It says draft.'),
      edit({ path: 'notes.txt', old_string: 'draft', new_string: 'final' }),
      say('Changed it to final.'),
      say('It already says final.'),
    );

    await product.send(first);
    await product.waitIdle();
    await product.expectReply('It says draft.');
    await product.send(second);
    await product.approve();
    await product.waitIdle();
    await product.expectReply('Changed it to final.');

    await product.undo();
    await product.expectComposer(second);
    await product.expectReply('It says draft.');
    await workspace.expectFile('notes.txt', 'final\n');

    model.expectCacheBreak('undo rewrites the history', { at: 'history' });
    await product.submit(second);
    await product.waitIdle();
    await product.expectReply('It already says final.');
    const resent = model.requests('main').at(-1);
    expect(resent?.texts('user')).toContain(first);
    expect(resent?.texts('user').filter((text) => text === second)).toHaveLength(1);
    expect(resent?.texts('assistant')).not.toContain('Changed it to final.');
  },
);
