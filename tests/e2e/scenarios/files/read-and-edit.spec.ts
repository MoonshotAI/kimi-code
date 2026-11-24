import { edit, read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'reads one file and edits another after approval',
  { workspace: { 'a.txt': 'hello\n', 'b.txt': 'old\n' } },
  async ({ product, model, workspace }) => {
    const prompt = 'Read a.txt, then change old to new in b.txt.';
    model.script(
      read('a.txt'),
      edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }),
      say('Done: b.txt now says new.'),
    );

    await product.send(prompt);
    await product.approve();
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.firstUserText)).toEqual([prompt, prompt, prompt]);
    expect(requests[1]?.texts('tool').join('\n')).toContain('hello');
    expect(requests[2]?.texts('tool').join('\n')).toContain('Replaced 1 occurrence in b.txt');
    await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
    await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
    await product.expectReply('Done: b.txt now says new.');
    await workspace.expectFile('b.txt', 'new\n');
  },
);
