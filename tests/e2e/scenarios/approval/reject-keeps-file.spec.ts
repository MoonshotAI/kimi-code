import { edit, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'leaves the file unchanged when the user rejects the edit',
  { workspace: { 'b.txt': 'old\n' } },
  async ({ product, model, workspace }) => {
    const prompt = 'Change old to new in b.txt.';
    model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Okay, I left b.txt unchanged.'));

    await product.send(prompt);
    await product.reject();
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.firstUserText)).toEqual([prompt, prompt]);
    expect(requests[1]?.texts('tool').join('\n')).toContain('was not run because the user rejected the approval request.');
    await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' });
    await product.expectReply('Okay, I left b.txt unchanged.');
    await workspace.expectFile('b.txt', 'old\n');
  },
);
