import { edit, read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the cards of the files it read and edited, with their file, after the user restarts the product',
  { workspace: { 'a.txt': 'hello\n', 'b.txt': 'old\n' } },
  async ({ product, model, workspace }) => {
    model.script(
      read('a.txt'),
      edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }),
      say('Read a.txt and updated b.txt.'),
    );

    await product.send('Read a.txt, then change old to new in b.txt.');
    await product.approve();
    await product.waitIdle();
    await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
    await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });

    await product.restart();
    await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
    await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
    await product.expectReply('Read a.txt and updated b.txt.');
    await workspace.expectFile('b.txt', 'new\n');
    expect(model.requests('main')).toHaveLength(3);
  },
);
